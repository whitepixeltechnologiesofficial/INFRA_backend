// @wpt/web — WPT chat mock server (WEB-2.x realtime + chat parity).
//
// The CHAT surface of the retired legacy demo web server, implemented with Node
// built-ins (node:http) + the standard `ws` WebSocket library. There is
// deliberately no Express and no third-party realtime framework here.
//
// WEB LINKING IS NOT IN THIS FILE. The link protocol (browser-generated token,
// registration, server push over the backend Socket.IO namespace, single-use
// code, one-browser session) has exactly one implementation, in apps/backend,
// reached by the Next BFF through API_BASE_URL. See the note above webSessions.
//
// Run standalone:  node server/wpt-server.mjs   (PORT, TYPING_TTL_MS)
// The Next.js client (apps/web/app) talks to these exact endpoints + events.

import http from "node:http";
import os from "node:os";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 3000;
// Typing-indicator ceiling (WEB-2.3). The server re-arms a timer on every
// typing:true and broadcasts typing:false shortly after the last one, so a chat
// never stays stuck on a typist who went quiet without sending. Harnesses
// override this (TYPING_TTL_MS) to prove the auto-clear without waiting 5s.
const TYPING_TTL = Number(process.env.TYPING_TTL_MS) || 5000;

// Message-send parity (text / image / voice). Canonical source of these
// numbers is packages/shared/src/messages.ts; scripts/web-22-verify.js pins
// them to the shared constants so they can't drift, and the Next.js client
// enforces the same cap from @wpt/shared at compose time.
const MESSAGE_KINDS = ["text", "image", "voice"];
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MiB, one limit shared by image + voice
const MIN_VOICE_SECONDS = 1;
const MAX_TEXT_LENGTH = 4000;
// readBody ceiling: 100 MiB of attachment base64 + JSON overhead. Anything
// larger is rejected as payload_too_large without being buffered to completion.
const MAX_REQUEST_BYTES = 150 * 1024 * 1024;

const users = [
  { id: "mervin", name: "Mervin Roger", role: "owner" },
  { id: "pravan", name: "Pravan", role: "admin" },
  { id: "satheesh", name: "Satheesh", role: "member" },
  { id: "rajesh", name: "Rajesh", role: "member" },
  { id: "krisha", name: "Krisha", role: "member" },
  { id: "jenslin", name: "Jenslin", role: "member" },
  { id: "arun", name: "Arun Kumar", role: "member" },
  { id: "deepak", name: "Deepak", role: "member" },
  { id: "naveen", name: "Naveen", role: "member" },
  { id: "vignesh", name: "Vignesh", role: "member" },
  { id: "harish", name: "Harish", role: "member" },
  { id: "sanjay", name: "Sanjay", role: "member" },
  { id: "karthik", name: "Karthik", role: "member" },
  { id: "ashwin", name: "Ashwin", role: "member" },
  { id: "rahul", name: "Rahul", role: "member" },
  { id: "dinesh", name: "Dinesh", role: "member" },
];
const groups = [
  {
    id: "project",
    name: "Project Group",
    description: "WPT project team",
    memberIds: ["mervin", "pravan", "satheesh", "rajesh", "krisha", "jenslin"],
    settings: { membersCanMessage: true, membersCanAdd: false },
  },
];
const messages = new Map();
const onlineUsers = new Set();
// Media attachments by id (image / voice payloads). Bytes are kept here only —
// message metadata (mKind/attachmentId/mimeType/sizeBytes) is what's stored or
// broadcast; the client never persists the payload itself.
const attachments = new Map();
// QA state for QR-1.3 / 1.4 demo mobile.
const mockPhones = new Map();
// Read receipts (WEB-2.3): `${chatKey}:${reader}` -> furthest read messageId.
// Direct chats have one reader per peer; groups keep one position per member.
const reads = new Map();
// Typing indicators (WEB-2.3): `${chatKey}:${typer}` -> TTL timer so a chat
// can never stay stuck showing a typist who went quiet without sending.
const typingTimers = new Map();
// WEB-2.4 — synced-contacts registry: userId -> Set<matched server userIds.
// Data source is the mobile app's address-book sync (PERM-2.16, hashes only);
// the relay holds the server-side match outcome. The Web client never asks the
// browser for Contacts — it only reads this list (GET /api/synced-contacts).
const syncedContacts = new Map();
// WEB-2.5 — registered numbers: e164 -> userId. Manual number entry in New
// Chat checks this registry (server-side) and, for a well-formed but
// unregistered number, the client shows a "not registered" state with NO
// invite/share affordance (Web intentionally excludes the mobile invite flow).
const registeredNumbers = new Map();
const key = (a, b) => [a, b].sort().join(":");
const groupKey = (g) => `group:${g}`;
const user = (id) => users.find((u) => u.id === id);
const now = () => new Date().toISOString();
function attachmentToken() {
  return crypto.randomBytes(9).toString("hex");
}
function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
  const m = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return null;
  const dirty = m[3] || "";
  const clean = dirty.replace(/\s+/g, "");
  if (!clean) return null;
  let bytes;
  try {
    bytes = Buffer.from(clean, "base64");
  } catch {
    return null;
  }
  if (bytes.toString("base64").replace(/=+$/, "") !== clean.replace(/=+$/, "")) return null;
  return { mimeType: m[1] || null, bytes };
}
function mediaPreview(m) {
  if (m && m.mKind === "image") return "Image";
  if (m && m.mKind === "voice") return "Voice message";
  return m ? String(m.text || "") : "";
}
function seed() {
  if (messages.size) return;
  messages.set(key("mervin", "pravan"), [{ id: "seed1", from: "pravan", text: "Hi Mervin! Welcome to WPT.", time: now() }]);
  messages.set(groupKey("project"), [{ id: "seed2", from: "pravan", text: "Welcome to the Project Group 👋", time: now() }]);
}
seed();

// WEB linking is NOT implemented here. This relay is the CHAT mock: it keeps the
// web-session concept the chat routes need (session validate, synced contacts,
// per-web-token rooms, new-phone-login cutoff) and nothing else. The linking
// protocol — browser-generated token, registration, server push, single-use code,
// one-browser session — has exactly ONE implementation, in apps/backend, and the
// Web app reaches it through the Next BFF and API_BASE_URL. A second QR/session
// implementation here would be precisely the duplication that is being removed.
const webSessions = new Map();
const invalidatedUsers = new Set();
function token() {
  return crypto.randomBytes(24).toString("hex");
}
function lanIps() {
  const out = [];
  for (const ns of Object.values(os.networkInterfaces())) {
    for (const n of ns || []) {
      if (n.family !== "IPv4" || n.internal) continue;
      const parts = n.address.split(".").map(Number);
      const privateIp =
        parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
      if (privateIp) out.push(n.address);
    }
  }
  return [...new Set(out)];
}
function lanIp() {
  const ips = lanIps();
  return ips.find((ip) => ip.startsWith("192.168.")) || ips.find((ip) => ip.startsWith("10.")) || ips.find((ip) => ip.startsWith("172.")) || ips[0] || null;
}
/**
 * WEB-R1.8 — a new/other device signing in terminates every live Web session
 * for the user immediately. The registry is cleared synchronously (no grace
 * window) and each affected live Web socket is pushed a webForceLoggedOut
 * event with the reason — never merely token invalidation.
 */
function invalidateWebForUser(uid, reason = "new_phone_login") {
  for (const [wt, s] of webSessions) {
    if (s.userId === uid) {
      webSessions.delete(wt);
      broadcast(`web:${wt}`, { type: "webForceLoggedOut", reason });
    }
  }
  // Do not mark the user globally: the newly-created Web session must not
  // immediately invalidate itself. Existing live Web sessions were already
  // notified above.
}

// ── HTTP helpers (node:http only) ──
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(data);
}
const TOO_LARGE = Symbol("too_large");
function readBody(req, limit = MAX_REQUEST_BYTES) {
  return new Promise((resolve) => {
    let b = "";
    let oversized = false;
    req.on("data", (c) => {
      if (oversized) return;
      b += c;
      if (b.length > limit) {
        oversized = true;
        b = "";
        req.destroy();
        resolve(TOO_LARGE);
      }
    });
    req.on("end", () => {
      if (oversized) return;
      let j = null;
      try {
        j = b ? JSON.parse(b) : null;
      } catch {
        j = null;
      }
      resolve(j);
    });
    req.on("error", () => resolve(oversized ? TOO_LARGE : null));
  });
}

// CORS for the browser SPA. The Web client is served by the Next.js app on its
// own port (dev story: NEXT_PUBLIC_WPT_API_URL points here), so API responses
// must allow that origin. Origin-reflecting + header-based auth only (no
// cookies), so no Allow-Credentials is needed. WebSocket is not CORS-restricted.
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Real-time surface — a JSON message protocol over the standard WebSocket.
//   server -> client: {type:'message'|'read'|'typing'|'webForceLoggedOut'
//                      |'webLoggedOff'|'mockPhoneStatus'|'mockIncomingMessage'
//                      |'presenceChanged'|'groupUpdated'|'usersUpdated', ...}
// Linking pushes (webLinkLogin) are NOT here — they travel on the backend's
// Socket.IO namespace, so there is exactly one link push implementation.
const rooms = new Map(); // room -> Set<WebSocket>
function joinRoom(ws, room) {
  if (!room) return;
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
}
function leaveRoom(ws, room) {
  const set = rooms.get(room);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) rooms.delete(room);
}
function broadcast(room, payload) {
  const set = rooms.get(room);
  if (!set) return;
  const frame = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1) {
      try {
        ws.send(frame);
      } catch {
        /* socket is closing */
      }
    }
  }
}

function clearTypingTimer(key) {
  const t = typingTimers.get(key);
  if (t) {
    clearTimeout(t);
    typingTimers.delete(key);
  }
}

// WEB-2.4 — the matched users for an account: registered users whose number
// resolved from the account's synced address book, minus the account itself.
function resolveSyncedContacts(uid) {
  const matched = syncedContacts.get(uid);
  if (!matched) return [];
  return users.filter((u) => u.id !== uid && matched.has(u.id));
}

// WEB-2.5 — server-side E.164 full-form normalizer, mirrors the client rule:
// country code required, 8-15 digits, country code never starts with 0. Null
// means malformed — the relay answers invalid_number BEFORE any registration
// lookup, so a bad number can never masquerade as "not registered".
function normalizeE164(raw) {
  const cleaned = String(raw == null ? "" : raw).trim().replace(/[\s().-]+/g, "");
  if (!/^\+[0-9]+$/.test(cleaned)) return null;
  const digits = cleaned.slice(1);
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits[0] === "0") return null;
  return "+" + digits;
}

// TTL auto-clear: once a typer goes quiet without sending, broadcast typing:false
// to the same rooms the typing:true reached. The timer is keyed per chat+typer so
// two group members typing at once never cancel each other.
function scheduleTypingClear(chatKey, payload, ttl) {
  clearTypingTimer(chatKey);
  const timer = setTimeout(() => {
    typingTimers.delete(chatKey);
    const off = { type: "typing", from: payload.from, typing: false, kind: payload.kind, at: now() };
    if (payload.kind === "group") {
      off.groupId = payload.groupId;
      const g = groups.find((x) => x.id === payload.groupId);
      broadcast(`group:${payload.groupId}`, off);
      if (g) for (const uid of g.memberIds) broadcast(`user:${uid}`, off);
    } else {
      off.to = payload.to;
      broadcast(`dm:${key(payload.from, payload.to)}`, off);
      broadcast(`user:${payload.from}`, off);
      broadcast(`user:${payload.to}`, off);
    }
  }, ttl);
  typingTimers.set(chatKey, timer);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  const method = req.method || "GET";

  applyCors(req, res);
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (p !== "/api/health" && !p.startsWith("/api/")) {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return;
  }

  // ── health ──
  if (p === "/api/health" && method === "GET") {
    sendJson(res, 200, { ok: true, service: "WPT Chat", users: users.length, groups: groups.length, websocket: true });
    return;
  }

  // ── users / groups ──
  if (p === "/api/users" && method === "GET") {
    sendJson(res, 200, users);
    return;
  }
  if (p === "/api/groups" && method === "GET") {
    sendJson(res, 200, groups.map((g) => ({ ...g, members: g.memberIds.map(user) })));
    return;
  }

  // ── message history / relay ──
  const msgPair = p.match(/^\/api\/messages\/([^/]+)\/([^/]+)$/);
  if (msgPair && method === "GET") {
    sendJson(res, 200, messages.get(key(decodeURIComponent(msgPair[1]), decodeURIComponent(msgPair[2]))) || []);
    return;
  }
  const groupMsg = p.match(/^\/api\/group-messages\/([^/]+)$/);
  if (groupMsg && method === "GET") {
    const gid = decodeURIComponent(groupMsg[1]);
    const caller = String(url.searchParams.get("userId") || "");
    const g = groups.find((x) => x.id === gid);
    if (!g) {
      sendJson(res, 404, { ok: false, error: "group_not_found" });
      return;
    }
    if (!caller || !g.memberIds.includes(caller)) {
      sendJson(res, 403, { ok: false, error: "not_member" });
      return;
    }
    sendJson(res, 200, messages.get(groupKey(gid)) || []);
    return;
  }
  if (p === "/api/messages/send" && method === "POST") {
    const body = (await readBody(req)) || {};
    if (body === TOO_LARGE) {
      sendJson(res, 413, { ok: false, error: "payload_too_large", message: `Attachment is too large — Sealine accepts up to 100 MB.` });
      return;
    }
    const { from, type, to, groupId, text, kind, dataUrl, mimeType, sizeBytes, durationSec } = body;
    if (!user(from)) {
      sendJson(res, 400, { ok: false, error: "bad_message" });
      return;
    }
    const hasKind = typeof kind === "string" && kind.length > 0;
    if (hasKind && !MESSAGE_KINDS.includes(kind)) {
      sendJson(res, 400, { ok: false, error: "bad_kind", message: "Unsupported message kind." });
      return;
    }
    const mKind = hasKind ? kind : "text";
    let attachment = null;
    if (mKind !== "text") {
      if (typeof dataUrl !== "string" || !dataUrl) {
        sendJson(res, 400, { ok: false, error: "bad_attachment", message: "Attachment payload is missing." });
        return;
      }
      const dec = decodeDataUrl(dataUrl);
      if (!dec) {
        sendJson(res, 400, { ok: false, error: "bad_attachment", message: "Attachment payload is not a valid data URL." });
        return;
      }
      const declaredSize = Number(sizeBytes);
      if (!Number.isFinite(declaredSize) || declaredSize < 0) {
        sendJson(res, 400, { ok: false, error: "bad_size", message: "Attachment size is invalid." });
        return;
      }
      if (declaredSize > MAX_ATTACHMENT_BYTES) {
        sendJson(res, 413, { ok: false, error: "attachment_too_large", maxBytes: MAX_ATTACHMENT_BYTES, message: `Attachment is too large — Sealine accepts up to 100 MB.` });
        return;
      }
      if (dec.bytes.length !== declaredSize) {
        sendJson(res, 400, { ok: false, error: "bad_size", message: "Attachment size does not match its payload." });
        return;
      }
      const mime = typeof mimeType === "string" && mimeType ? mimeType : dec.mimeType || "";
      if (!mime || !mime.startsWith(mKind === "image" ? "image/" : "audio/")) {
        sendJson(res, 400, { ok: false, error: "bad_mime", message: `Unsupported file type for ${mKind} attachments.` });
        return;
      }
      if (mKind === "voice" && !(typeof durationSec === "number" && isFinite(durationSec) && durationSec >= MIN_VOICE_SECONDS)) {
        sendJson(res, 400, { ok: false, error: "voice_too_short", message: `Voice message is too short — hold the mic for at least ${MIN_VOICE_SECONDS} second.` });
        return;
      }
      attachment = { bytes: dec.bytes, mime, declaredSize, durationSec: typeof durationSec === "number" ? durationSec : undefined };
    }
    let msg;
    if (attachment) {
      const attachmentId = attachmentToken();
      attachments.set(attachmentId, { mimeType: attachment.mime, sizeBytes: attachment.declaredSize, bytes: attachment.bytes });
      msg = { id: Date.now() + Math.random(), from, text: "", mKind, attachmentId, mimeType: attachment.mime, sizeBytes: attachment.declaredSize, time: now() };
      if (mKind === "voice" && attachment.durationSec != null) msg.durationSec = attachment.durationSec;
    } else {
      const trimmed = String(text || "").trim();
      if (!trimmed) {
        sendJson(res, 400, { ok: false, error: "bad_message" });
        return;
      }
      if (trimmed.length > MAX_TEXT_LENGTH) {
        sendJson(res, 400, {
          ok: false,
          error: "message_too_long",
          maxLength: MAX_TEXT_LENGTH,
          message: `Message is too long — Sealine accepts up to ${MAX_TEXT_LENGTH.toLocaleString("en-US")} characters.`,
        });
        return;
      }
      msg = { id: Date.now() + Math.random(), from, text: trimmed, time: now() };
    }
    if (type === "direct") {
      if (!user(to)) {
        sendJson(res, 404, { ok: false, error: "user_not_found" });
        return;
      }
      const k = key(from, to);
      if (!messages.has(k)) messages.set(k, []);
      messages.get(k).push(msg);
      broadcast(`dm:${k}`, { type: "message", ...msg, kind: "direct", to });
      broadcast(`user:${to}`, { type: "message", ...msg, kind: "direct", to });
    } else if (type === "group") {
      const g = groups.find((x) => x.id === groupId);
      if (!g || !g.memberIds.includes(from)) {
        sendJson(res, 403, { ok: false, error: "not_member" });
        return;
      }
      const k = groupKey(g.id);
      if (!messages.has(k)) messages.set(k, []);
      messages.get(k).push(msg);
      broadcast(`group:${g.id}`, { type: "message", ...msg, kind: "group", groupId: g.id });
      for (const uid of g.memberIds) broadcast(`user:${uid}`, { type: "message", ...msg, kind: "group", groupId: g.id });
    } else {
      sendJson(res, 400, { ok: false, error: "bad_type" });
      return;
    }
    sendJson(res, 200, { ok: true, message: msg });
    return;
  }

  // ── read receipts (WEB-2.3) ──
  if (p === "/api/messages/read" && method === "POST") {
    const body = (await readBody(req)) || {};
    if (body === TOO_LARGE) {
      sendJson(res, 413, { ok: false, error: "payload_too_large", message: `Attachment is too large — Sealine accepts up to 100 MB.` });
      return;
    }
    const { from, to, groupId, type, messageId } = body;
    if (!user(from)) {
      sendJson(res, 400, { ok: false, error: "bad_read" });
      return;
    }
    const mid = String(messageId ?? "");
    if (!mid) {
      sendJson(res, 400, { ok: false, error: "bad_read", message: "messageId is required." });
      return;
    }
    if (type === "group") {
      const g = groups.find((x) => x.id === groupId);
      if (!g || !g.memberIds.includes(from)) {
        sendJson(res, 403, { ok: false, error: "not_member" });
        return;
      }
      const arr = messages.get(groupKey(g.id)) || [];
      const idx = arr.findIndex((m) => String(m.id) === mid);
      if (idx === -1) {
        sendJson(res, 404, { ok: false, error: "read_not_found" });
        return;
      }
      // Everything up to and including the reported message is now read by
      // `from` — but only messages the reporter didn't write themselves.
      const readIds = arr.slice(0, idx + 1).filter((m) => m.from !== from).map((m) => String(m.id));
      reads.set(`${groupKey(g.id)}:${from}`, mid);
      const payload = { type: "read", from, groupId: g.id, messageId: mid, messageIds: readIds, at: now() };
      broadcast(`group:${g.id}`, payload);
      for (const uid of g.memberIds) broadcast(`user:${uid}`, payload);
      sendJson(res, 200, { ok: true, read: readIds.length, messageId: mid });
      return;
    }
    if (!user(to)) {
      sendJson(res, 404, { ok: false, error: "user_not_found" });
      return;
    }
    const arr = messages.get(key(from, to)) || [];
    const idx = arr.findIndex((m) => String(m.id) === mid);
    if (idx === -1) {
      sendJson(res, 404, { ok: false, error: "read_not_found" });
      return;
    }
    const readIds = arr.slice(0, idx + 1).filter((m) => m.from === to).map((m) => String(m.id));
    reads.set(`${key(from, to)}:${from}`, mid);
    const payload = { type: "read", from, to, messageId: mid, messageIds: readIds, at: now() };
    broadcast(`dm:${key(from, to)}`, payload);
    broadcast(`user:${from}`, payload);
    broadcast(`user:${to}`, payload);
    sendJson(res, 200, { ok: true, read: readIds.length, messageId: mid });
    return;
  }

  // ── typing indicators (WEB-2.3) ──
  if (p === "/api/messages/typing" && method === "POST") {
    const body = (await readBody(req)) || {};
    if (body === TOO_LARGE) {
      sendJson(res, 413, { ok: false, error: "payload_too_large", message: `Attachment is too large — Sealine accepts up to 100 MB.` });
      return;
    }
    const { from, to, groupId, type, typing } = body;
    if (!user(from)) {
      sendJson(res, 400, { ok: false, error: "bad_typing" });
      return;
    }
    const isTyping = typing === true;
    if (type === "group") {
      const g = groups.find((x) => x.id === groupId);
      if (!g || !g.memberIds.includes(from)) {
        sendJson(res, 403, { ok: false, error: "not_member" });
        return;
      }
      const chatKey = `${groupKey(g.id)}:${from}`;
      if (isTyping) {
        const payload = { type: "typing", from, typing: true, kind: "group", groupId: g.id, at: now() };
        broadcast(`group:${g.id}`, payload);
        for (const uid of g.memberIds) broadcast(`user:${uid}`, payload);
        scheduleTypingClear(chatKey, payload, TYPING_TTL);
      } else if (typingTimers.has(chatKey)) {
        clearTypingTimer(chatKey);
        const payload = { type: "typing", from, typing: false, kind: "group", groupId: g.id, at: now() };
        broadcast(`group:${g.id}`, payload);
        for (const uid of g.memberIds) broadcast(`user:${uid}`, payload);
      }
      sendJson(res, 200, { ok: true, typing: isTyping });
      return;
    }
    if (!user(to)) {
      sendJson(res, 404, { ok: false, error: "user_not_found" });
      return;
    }
    const chatKey = `${key(from, to)}:${from}`;
    if (isTyping) {
      const payload = { type: "typing", from, typing: true, kind: "direct", to, at: now() };
      broadcast(`dm:${key(from, to)}`, payload);
      broadcast(`user:${from}`, payload);
      broadcast(`user:${to}`, payload);
      scheduleTypingClear(chatKey, payload, TYPING_TTL);
    } else if (typingTimers.has(chatKey)) {
      clearTypingTimer(chatKey);
      const payload = { type: "typing", from, typing: false, kind: "direct", to, at: now() };
      broadcast(`dm:${key(from, to)}`, payload);
      broadcast(`user:${from}`, payload);
      broadcast(`user:${to}`, payload);
    }
    sendJson(res, 200, { ok: true, typing: isTyping });
    return;
  }

  // ── media download (image / voice attachments) ──
  const media = p.match(/^\/api\/media\/([^/]+)$/);
  if (media && method === "GET") {
    const a = attachments.get(decodeURIComponent(media[1]));
    if (!a) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    res.writeHead(200, { "Content-Type": a.mimeType, "Content-Length": a.bytes.length, "Cache-Control": "no-store" });
    res.end(a.bytes);
    return;
  }

  // ── recent chats ──
  const recent = p.match(/^\/api\/recent-chats\/([^/]+)$/);
  if (recent && method === "GET") {
    const uid = decodeURIComponent(recent[1]);
    const items = [];
    for (const u of users) {
      if (u.id === uid) continue;
      const arr = messages.get(key(uid, u.id)) || [];
      if (arr.length) {
        const last = arr[arr.length - 1];
        items.push({ type: "direct", id: u.id, name: u.name, preview: mediaPreview(last), time: last.time, online: onlineUsers.has(u.id) });
      }
    }
    for (const g of groups) {
      const arr = messages.get(groupKey(g.id)) || [];
      if (arr.length) {
        const last = arr[arr.length - 1];
        items.push({ type: "group", id: g.id, name: g.name, preview: mediaPreview(last), time: last.time, online: false });
      }
    }
    items.sort((a, b) => new Date(b.time) - new Date(a.time));
    sendJson(res, 200, { items });
    return;
  }

  // ── Web session validate / logout (chat-mock sessions; the LINK protocol
  // lives only in apps/backend — see the note above the webSessions map) ──
  const validate = p.match(/^\/api\/session\/validate\/([^/]+)$/);
  if (validate && method === "GET") {
    const s = webSessions.get(decodeURIComponent(validate[1]));
    if (!s) {
      sendJson(res, 401, { ok: false, error: "session_invalid" });
      return;
    }
    sendJson(res, 200, { ok: true, userId: s.userId });
    return;
  }
  if (p === "/api/session/logout" && method === "POST") {
    const body = (await readBody(req)) || {};
    const wt = body?.webToken;
    const s = webSessions.get(wt);
    if (s) {
      webSessions.delete(wt);
      broadcast(`web:${wt}`, { type: "webLoggedOff", ok: true });
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── synced contacts (WEB-2.4) ──
  // The New Chat panel's data source. Auth is the web session token; the list
  // is server-matched only (never a browser Contacts permission prompt).
  // Sprint 3: an additive userId variant exists for the Next BFF relay, which
  // has already validated the HttpOnly web session against the backend.
  const syncedList = p.match(/^\/api\/synced-contacts\/([^/]+)$/);
  if (syncedList && method === "GET") {
    const s = webSessions.get(decodeURIComponent(syncedList[1]));
    if (!s) {
      sendJson(res, 401, { ok: false, error: "session_invalid" });
      return;
    }
    sendJson(res, 200, { ok: true, synced: resolveSyncedContacts(s.userId) });
    return;
  }
  if (p === "/api/synced-contacts" && method === "GET") {
    const uid = String(new URL(req.url, `http://${req.headers.host || "localhost"}`).searchParams.get("userId") || "");
    if (!user(uid)) {
      sendJson(res, 401, { ok: false, error: "session_invalid" });
      return;
    }
    sendJson(res, 200, { ok: true, synced: resolveSyncedContacts(uid) });
    return;
  }

  // ── manual number check (WEB-2.5) ──
  // Format validation runs FIRST (400 invalid_number); only a well-formed
  // number is looked up for registration. An unregistered number is
  // `registered:false` — the client shows "not registered" and never an
  // invite affordance.
  if (p === "/api/contacts/check" && method === "POST") {
    const body = (await readBody(req)) || {};
    const e164 = normalizeE164(body?.number);
    if (!e164) {
      sendJson(res, 400, { ok: false, error: "invalid_number", message: "That doesn't look like a phone number — include the country code." });
      return;
    }
    const uid = registeredNumbers.get(e164);
    const target = uid ? user(uid) : null;
    if (!target) {
      sendJson(res, 200, { ok: true, registered: false });
      return;
    }
    sendJson(res, 200, { ok: true, registered: true, user: target });
    return;
  }

  // ── QA mock controls (simulate the phone; Web remains independent) ──
  const phoneStatus = p.match(/^\/api\/mock\/phone-status\/([^/]+)$/);
  if (phoneStatus && method === "GET") {
    const st = mockPhones.get(decodeURIComponent(phoneStatus[1])) || { online: true, missed: [] };
    sendJson(res, 200, { ok: true, online: st.online, missed: st.missed.length });
    return;
  }
  if (p === "/api/mock/phone-offline" && method === "POST") {
    const body = (await readBody(req)) || {};
    const uid = body?.userId || "mervin";
    const st = mockPhones.get(uid) || { online: true, missed: [] };
    st.online = false;
    mockPhones.set(uid, st);
    broadcast(`user:${uid}`, { type: "mockPhoneStatus", online: false });
    sendJson(res, 200, { ok: true, online: false });
    return;
  }
  if (p === "/api/mock/phone-message" && method === "POST") {
    const body = (await readBody(req)) || {};
    const uid = body?.userId || "mervin";
    const text = String(body?.text || "Message received while the demo phone was offline.").trim();
    const st = mockPhones.get(uid) || { online: true, missed: [] };
    const msg = { id: Date.now() + Math.random(), from: "pravan", text, time: now(), demo: true };
    const k = key(uid, "pravan");
    if (!messages.has(k)) messages.set(k, []);
    messages.get(k).push(msg);
    if (!st.online) st.missed.push(msg);
    else broadcast(`user:${uid}`, { type: "mockIncomingMessage", ...msg, kind: "direct", to: "pravan" });
    mockPhones.set(uid, st);
    sendJson(res, 200, { ok: true, queued: !st.online, message: msg });
    return;
  }
  if (p === "/api/mock/phone-online" && method === "POST") {
    const body = (await readBody(req)) || {};
    const uid = body?.userId || "mervin";
    const st = mockPhones.get(uid) || { online: true, missed: [] };
    st.online = true;
    const missed = [...st.missed];
    st.missed = [];
    mockPhones.set(uid, st);
    broadcast(`user:${uid}`, { type: "mockPhoneStatus", online: true });
    for (const msg of missed) broadcast(`user:${uid}`, { type: "mockIncomingMessage", ...msg, kind: "direct", to: "pravan" });
    sendJson(res, 200, { ok: true, online: true, synced: missed.length, messages: missed });
    return;
  }
  if (p === "/api/mock/new-phone-login" && method === "POST") {
    const body = (await readBody(req)) || {};
    invalidateWebForUser(body?.userId || "mervin", "new_phone_login");
    sendJson(res, 200, { ok: true });
    return;
  }
  if (p === "/api/mock/link-web" && method === "POST") {
    const body = (await readBody(req)) || {};
    const target = user(body?.userId) || user("mervin");
    if (!target) {
      sendJson(res, 404, { ok: false, error: "unknown_user" });
      return;
    }
    invalidateWebForUser(target.id, "new_phone_login");
    const webToken = token();
    webSessions.set(webToken, { userId: target.id, linkedAt: Date.now() });
    sendJson(res, 200, { ok: true, webToken, userId: target.id });
    return;
  }
  if (p === "/api/mock/web-sessions" && method === "GET") {
    sendJson(res, 200, {
      ok: true,
      sessions: [...webSessions.values()].map((s) => ({ userId: s.userId, linkedAt: s.linkedAt })),
    });
    return;
  }
  // WEB-2.4 — QA knob for the synced-contacts registry (stands in for the
  // PERM-2.16 mobile sync landing its hashes; here `matched` is the resolved
  // match outcome). Unknown ids are dropped; an empty array clears the list.
  if (p === "/api/mock/sync-contacts" && method === "POST") {
    const body = (await readBody(req)) || {};
    const uid = String(body?.userId || "mervin");
    if (!user(uid)) {
      sendJson(res, 404, { ok: false, error: "unknown_user" });
      return;
    }
    const matched = Array.isArray(body?.matched)
      ? [...new Set(body.matched.map(String).filter((id) => !!id && !!user(id)))]
      : [];
    syncedContacts.set(uid, new Set(matched));
    sendJson(res, 200, { ok: true, synced: resolveSyncedContacts(uid) });
    return;
  }
  // WEB-2.5 — QA knobs for the registered-numbers registry (stand-in for the
  // account store that knows which numbers are on Sealine). The mock enforces
  // the same E.164 rule, so a malformed number is rejected here too.
  if (p === "/api/mock/register-number" && method === "POST") {
    const body = (await readBody(req)) || {};
    const uid = String(body?.userId || "mervin");
    const target = user(uid);
    if (!target) {
      sendJson(res, 404, { ok: false, error: "unknown_user" });
      return;
    }
    const e164 = normalizeE164(body?.number);
    if (!e164) {
      sendJson(res, 400, { ok: false, error: "invalid_number" });
      return;
    }
    registeredNumbers.set(e164, uid);
    sendJson(res, 200, { ok: true, number: e164, user: target });
    return;
  }
  if (p === "/api/mock/unregister-number" && method === "POST") {
    const body = (await readBody(req)) || {};
    const e164 = normalizeE164(body?.number);
    if (!e164) {
      sendJson(res, 400, { ok: false, error: "invalid_number" });
      return;
    }
    registeredNumbers.delete(e164);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not_found" });
}

// ── WebSocket (real-time) ──
const REALTIME_TICKET_ISS = "wpt-backend";
const REALTIME_TICKET_AUD = "wpt-realtime";

function verifyRealtimeTicket(ticket) {
  const secret = process.env.JWT_SECRET;
  if (!secret || typeof ticket !== "string") return null;
  const parts = ticket.split(".");
  if (parts.length !== 3) return null;
  const [head, payload, sig] = parts;
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!header || header.alg !== "HS256") return null;
  const expected = crypto.createHmac("sha256", secret).update(`${head}.${payload}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  if (claims.iss !== REALTIME_TICKET_ISS || claims.aud !== REALTIME_TICKET_AUD) return null;
  if (claims.ticket !== true) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) return null;
  return claims.sub;
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(() => sendJson(res, 500, { ok: false, error: "internal_error" }));
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const q = url.searchParams;
  let myRooms = [];
  // Chat-mock rooms only. The `qr:<token>` room and the qrSession handshake were
  // removed with the relay's link protocol: the backend's Socket.IO link channel
  // is the single push path for linking, and no browser joins it here.
  const webToken = q.get("webToken");
  if (webToken) {
    joinRoom(ws, `web:${webToken}`);
    myRooms.push(`web:${webToken}`);
    const wsSession = webSessions.get(webToken);
    if (wsSession) {
      joinRoom(ws, `user:${wsSession.userId}`);
      myRooms.push(`user:${wsSession.userId}`);
    }
  }
  ws.on("message", (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "join") {
      const uid = verifyRealtimeTicket(msg.ticket);
      if (!uid || !user(uid)) {
        ws.close(4001, "unauthorized");
        return;
      }
      myRooms.forEach((r) => leaveRoom(ws, r));
      myRooms = [];
      onlineUsers.add(uid);
      joinRoom(ws, `user:${uid}`);
      myRooms.push(`user:${uid}`);
      for (const w of rooms.get(`user:${uid}`) || []) {
        if (w !== ws) w.send(JSON.stringify({ type: "presenceChanged", userId: uid, online: true }));
      }
      if (invalidatedUsers.has(uid)) {
        ws.send(JSON.stringify({ type: "webForceLoggedOut", reason: "new_phone_login" }));
        invalidatedUsers.delete(uid);
      }
      return;
    }  });
  ws.on("close", () => {
    myRooms.forEach((r) => leaveRoom(ws, r));
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const ips = lanIps();
  console.log(`WPT web server: http://localhost:${PORT}`);
  console.log(`LAN: ${ips.map((ip) => `http://${ip}:${PORT}`).join(" | ") || "No private LAN IPv4 found"}`);
  console.log("Linking: served by the backend (API_BASE_URL) — this relay is chat-only.");
});
