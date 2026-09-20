// @wpt/web — WEB-R1.1–R1.8 server.
//
// Replacement for the retired legacy demo web server. Same verified API
// contract and real-time event protocol, implemented with Node built-ins
// (node:http) + the standard `ws` WebSocket library. There is deliberately
// no Express and no third-party realtime framework in the web stack.
//
// Run standalone:  node server/wpt-server.mjs   (PORT, QR_TTL_MS, PUBLIC_BASE_URL)
// The Next.js client (apps/web/app) talks to these exact endpoints + events.

import http from "node:http";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { WebSocketServer } from "ws";
import QRCode from "./vendor/QRCode/index.js";

const PORT = Number(process.env.PORT) || 3000;
const TTL = Number(process.env.QR_TTL_MS) || 60000;

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
// QA state for QR-1.3 / 1.4 demo mobile.
const mockPhones = new Map();
const key = (a, b) => [a, b].sort().join(":");
const groupKey = (g) => `group:${g}`;
const user = (id) => users.find((u) => u.id === id);
const now = () => new Date().toISOString();
function seed() {
  if (messages.size) return;
  messages.set(key("mervin", "pravan"), [{ id: "seed1", from: "pravan", text: "Hi Mervin! Welcome to WPT.", time: now() }]);
  messages.set(groupKey("project"), [{ id: "seed2", from: "pravan", text: "Welcome to the Project Group 👋", time: now() }]);
}
seed();

// QR-1.0 mock API layer: all QR/link/session state lives here, never in the UI.
const qrSessions = new Map();
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
function publicOrigin(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.WPT_PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  const host = req.headers.host || `localhost:${PORT}`;
  const hostname = host.split(":")[0];
  const port = host.includes(":") ? host.split(":").pop() : PORT;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") {
    const ip = lanIp();
    if (ip) return `http://${ip}:${port}`;
  }
  return `http://${host}`;
}
function makeQr() {
  const t = token();
  const s = { token: t, accountId: "mervin", createdAt: Date.now(), expiresAt: Date.now() + TTL, status: "active", webToken: null };
  qrSessions.set(t, s);
  return s;
}
function activeQr() {
  for (const [t, s] of qrSessions) {
    if (Date.now() > s.expiresAt) {
      qrSessions.delete(t);
      continue;
    }
    if (s.status === "active") return s;
  }
  return makeQr();
}
function pngDataUrl(text) {
  const qr = new QRCode(0, 2); // High error correction for reliable phone-camera scanning.
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const scale = 10;
  const quiet = 8;
  const size = (n + quiet * 2) * scale;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    const mr = Math.floor(y / scale) - quiet;
    for (let x = 0; x < size; x++) {
      const mc = Math.floor(x / scale) - quiet;
      const dark = mr >= 0 && mc >= 0 && mr < n && mc < n && qr.isDark(mr, mc);
      raw[o++] = dark ? 0 : 255;
      raw[o++] = dark ? 0 : 255;
      raw[o++] = dark ? 0 : 255;
      raw[o++] = 255;
    }
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const t = Buffer.from(type);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    t.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
    return out;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return "data:image/png;base64," + png.toString("base64");
}
function findQr(t) {
  const s = qrSessions.get(t);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    qrSessions.delete(t);
    return null;
  }
  return s;
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
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 200 * 1024) req.destroy();
    });
    req.on("end", () => {
      let j = null;
      try {
        j = b ? JSON.parse(b) : null;
      } catch {
        j = null;
      }
      resolve(j);
    });
    req.on("error", () => resolve(null));
  });
}

// Real-time surface — a JSON message protocol over the standard WebSocket.
//   server -> client: {type:'accountLinked'|'qrExpired'|'message'|'webForceLoggedOut'|'webLoggedOff'
//                      |'mockPhoneStatus'|'mockIncomingMessage'|'presenceChanged'|'groupUpdated'|'usersUpdated', ...}
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

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  const method = req.method || "GET";

  // Demo phone page (the QR scan target).
  if (p.startsWith("/phone/link/")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(phonePage(url.pathname.split("/").pop()));
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
    sendJson(res, 200, messages.get(groupKey(decodeURIComponent(groupMsg[1]))) || []);
    return;
  }
  if (p === "/api/messages/send" && method === "POST") {
    const body = (await readBody(req)) || {};
    const { from, type, to, groupId, text } = body;
    if (!user(from) || !String(text || "").trim()) {
      sendJson(res, 400, { ok: false, error: "bad_message" });
      return;
    }
    const msg = { id: Date.now() + Math.random(), from, text: String(text).trim().slice(0, 4000), time: now() };
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
        items.push({ type: "direct", id: u.id, name: u.name, preview: last.text, time: last.time, online: onlineUsers.has(u.id) });
      }
    }
    for (const g of groups) {
      const arr = messages.get(groupKey(g.id)) || [];
      if (arr.length) {
        const last = arr[arr.length - 1];
        items.push({ type: "group", id: g.id, name: g.name, preview: last.text, time: last.time, online: false });
      }
    }
    items.sort((a, b) => new Date(b.time) - new Date(a.time));
    sendJson(res, 200, { items });
    return;
  }

  // ── QR linking (WEB-R1.1–R1.3) ──
  if (p === "/api/link/new" && method === "GET") {
    // Only one live QR at a time. Old active QR is replaced (and any already-expired
    // sessions are swept) so regeneration always mints a fresh token — the same token
    // is never served twice across the TTL.
    for (const [t, s] of qrSessions) {
      if (Date.now() > s.expiresAt) {
        qrSessions.delete(t);
        continue;
      }
      if (s.status === "active") {
        s.status = "replaced";
        broadcast(`qr:${t}`, { type: "qrExpired", reason: "replaced" });
      }
    }
    const s = makeQr();
    const linkUrl = `${publicOrigin(req)}/phone/link/${encodeURIComponent(s.token)}`;
    const qrDataUrl = pngDataUrl(linkUrl);
    sendJson(res, 200, { ok: true, sessionId: s.token, token: s.token, expiresAt: s.expiresAt, linkUrl, qrDataUrl });
    return;
  }
  const linkScan = p.match(/^\/api\/link\/([^/]+)$/);
  if (linkScan && method === "GET") {
    const s = findQr(decodeURIComponent(linkScan[1]));
    if (!s) {
      sendJson(res, 410, { ok: false, error: "expired", message: "This QR has expired. Refresh the Web page and scan the new code." });
      return;
    }
    if (s.status !== "active") {
      sendJson(res, 410, { ok: false, error: "already_used", message: "This QR has already been used to link a device." });
      return;
    }
    sendJson(res, 200, { ok: true, accountName: user(s.accountId).name, accountHint: "WPT account", expiresAt: s.expiresAt });
    return;
  }
  const linkConfirm = p.match(/^\/api\/link\/([^/]+)\/confirm$/);
  if (linkConfirm && method === "POST") {
    const s = findQr(decodeURIComponent(linkConfirm[1]));
    if (!s) {
      sendJson(res, 410, { ok: false, error: "expired", message: "This QR has expired. Refresh the Web page and scan the new code." });
      return;
    }
    if (s.status !== "active") {
      sendJson(res, 410, { ok: false, error: "already_used", message: "This QR has already been used to link a device." });
      return;
    }
    s.status = "linking";
    setTimeout(() => {
      // Enforce the TTL all the way through the linking window: a token that expires
      // between the phone's scan and this callback is never allowed to create a session.
      const current = qrSessions.get(s.token);
      if (!current || current.status !== "linking") return;
      if (Date.now() > current.expiresAt) {
        current.status = "expired";
        broadcast(`qr:${current.token}`, { type: "qrExpired", reason: "expired" });
        return;
      }
      invalidateWebForUser(current.accountId, "new_phone_login");
      current.status = "linked";
      current.linkedAt = Date.now();
      current.webToken = token();
      webSessions.set(current.webToken, { userId: current.accountId, linkedAt: current.linkedAt, qrToken: current.token });
      broadcast(`qr:${current.token}`, { type: "accountLinked", webToken: current.webToken, userId: current.accountId });
    }, 650);
    sendJson(res, 200, { ok: true, state: "linking" });
    return;
  }

  // ── web session validate / logout (WEB-R1.4 / R1.6 / R1.8) ──
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
  if (p === "/api/mock/qr-sessions" && method === "GET") {
    sendJson(res, 200, {
      ok: true,
      sessions: [...qrSessions.values()].map((s) => ({ token: s.token, status: s.status, expired: Date.now() > s.expiresAt, linked: !!s.webToken })),
    });
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

  sendJson(res, 404, { ok: false, error: "not_found" });
}

// ── WebSocket (real-time) ──
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(() => sendJson(res, 500, { ok: false, error: "internal_error" }));
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const q = url.searchParams;
  let myRooms = [];
  const qrToken = q.get("qrSession");
  const webToken = q.get("webToken");
  if (qrToken) {
    joinRoom(ws, `qr:${qrToken}`);
    myRooms.push(`qr:${qrToken}`);
  }
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
      const uid = msg.userId;
      if (!user(uid)) return;
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
    }
  });
  ws.on("close", () => {
    myRooms.forEach((r) => leaveRoom(ws, r));
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const ips = lanIps();
  console.log(`WPT web server: http://localhost:${PORT}`);
  console.log(`LAN: ${ips.map((ip) => `http://${ip}:${PORT}`).join(" | ") || "No private LAN IPv4 found"}`);
  console.log("QR base: " + (process.env.PUBLIC_BASE_URL || process.env.WPT_PUBLIC_BASE_URL || "auto-detected LAN address"));
});

// ── Demo phone page (the QR scan target) ──
function phonePage(encodedToken) {
  const token = decodeURIComponent(encodedToken || "");
  const script = `
const token=${JSON.stringify(token)};
const $=id=>document.getElementById(id),uid='mervin';
function show(id){['confirm','linking','demo','error'].forEach(x=>$(x).classList.toggle('hidden',x!==id));}
async function api(url,body={}){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.message||d.error||'Request failed');return d;}
function toast(t){$('toast').textContent=t;setTimeout(()=>{$('toast').textContent=''},2600);}
function status(online){$('status').classList.toggle('offline',!online);$('status').innerHTML='<span class="dot"></span><b>Demo phone: '+(online?'Online':'Offline')+'</b><br><small>Web remains fully independent.</small>';}
async function load(){try{const r=await fetch('/api/link/'+encodeURIComponent(token),{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.message||d.error||'Request failed');$('name').textContent=d.accountName;}catch(e){$('errorText').textContent=e.message;show('error');}}
$('cancel').onclick=()=>{location.href='/';};
$('link').onclick=async()=>{try{$('link').disabled=true;show('linking');await api('/api/link/'+encodeURIComponent(token)+'/confirm',{authenticated:true});setTimeout(()=>show('demo'),900);}catch(e){$('errorText').textContent=e.message;show('error');}};
$('offline').onclick=async()=>{await api('/api/mock/phone-offline',{userId:uid});status(false);toast('Phone is offline. Web should still work normally.');};
$('queue').onclick=async()=>{const d=await api('/api/mock/phone-message',{userId:uid,text:'Demo catch-up message from Pravan — '+new Date().toLocaleTimeString()});toast(d.queued?'Message queued for reconnect.':'Message delivered while online.');};
$('online').onclick=async()=>{const d=await api('/api/mock/phone-online',{userId:uid});status(true);toast('Phone reconnected. '+d.synced+' missed message(s) synced silently.');};
$('newphone').onclick=async()=>{await api('/api/mock/new-phone-login',{userId:uid});toast('New phone login simulated. Web session was force-logged out.');};
load();
`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WPT Demo Mobile</title>
<style>
:root{--bg:#0b0f14;--panel:#15171c;--panel2:#1b1f26;--line:#2e323c;--text:#f3f3f4;--muted:#9aa0ac;--accent:#3fc6b8;--danger:#e5484d}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(135deg,var(--bg),var(--panel2));font-family:Arial,sans-serif;color:var(--text);display:grid;place-items:center;padding:18px}
.card{width:min(430px,100%);background:var(--panel);border:1px solid var(--line);border-radius:26px;padding:26px;box-shadow:0 20px 55px #0007;text-align:center}
.brand{display:flex;justify-content:center;align-items:center;gap:10px;margin-bottom:20px}
.logo{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:var(--accent);font-weight:700;color:#fff}
.brand b{font-size:20px}h1{font-size:24px;margin:0 0 10px}p{color:var(--muted);font-size:14px;line-height:1.55}
.device,.status{margin:18px 0;padding:14px;border:1px solid var(--line);border-radius:15px;background:var(--panel2);text-align:left}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--accent);margin-right:8px}
.offline .dot{background:var(--danger)}button{width:100%;border:0;border-radius:13px;padding:14px;margin-top:10px;font-weight:700;cursor:pointer;background:var(--accent);color:#fff}
.secondary{background:transparent;border:1px solid var(--line);color:var(--text)}.danger{background:var(--danger)}
.hidden{display:none}.spinner{width:34px;height:34px;border:3px solid #ffffff22;border-top-color:var(--accent);border-radius:50%;margin:20px auto;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}.small{font-size:11px;color:var(--muted);margin-top:16px}.toast{min-height:20px;color:var(--accent);font-size:13px;margin-top:12px}
</style></head><body>
<main class="card"><div class="brand"><div class="logo">S</div><b>WPT</b></div>
<section id="confirm"><h1>Link this device?</h1><p>You're about to add this browser to your WPT account.</p><div class="device"><b id="name">Checking request…</b></div><button id="link">Link device</button><button class="secondary" id="cancel">Cancel</button></section>
<section id="linking" class="hidden"><div class="spinner"></div><h1>Linking your device…</h1><p>Securely confirming this browser.</p></section>
<section id="demo" class="hidden"><h1>WPT Demo Mobile</h1><p>Use this phone to test QR-1.3, QR-1.4 and QR-1.7.</p><div class="status" id="status"><span class="dot"></span><b>Demo phone: Online</b><br><small>Web remains fully independent.</small></div><button id="offline">Go Offline — QR-1.3</button><button class="secondary" id="queue">Create missed message</button><button id="online" class="secondary">Come Back Online — QR-1.4</button><button id="newphone" class="danger">Simulate New Phone Login — QR-1.7</button><div class="toast" id="toast"></div><div class="small">QR-1.4 reconnect shows no progress UI on Web. New messages should simply appear.</div></section>
<section id="error" class="hidden"><h1 style="color:var(--danger)">Link unavailable</h1><p id="errorText">Scan the newest QR code shown on Web.</p></section>
</main>
<script>${script}</script></body></html>`;
}