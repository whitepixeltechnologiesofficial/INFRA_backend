// WEB 2.2 — Message Sending Parity (text / image / voice) verification.
//
// Proves the stretch goal end-to-end over the REAL live pipeline (each suite
// gets its own wpt-server.mjs on a unique port):
//
//   * text sends keep the exact legacy relay contract (no mKind/attachment);
//   * image + voice attachments are accepted, stored, served back at
//     /api/media/:id, broadcast live to the recipient over the WebSocket,
//     and previewed in recent-chats via the shared media preview text;
//   * the ONE shared cap (100 MiB from @wpt/shared) is enforced by the server
//     with a clear, human error, and unknown/bad kinds + short voices +
//     mismatched sizes are rejected server-side;
//   * the Web client enforces the same shared rules at compose time and never
//     persists media payloads (in-memory only), while the WPT web server pins
//     the shared constants (no drift).
//
// The shared + api-client modules are imported as real TS source; Node's
// native type stripping runs them (packages/shared + packages/api-client are
// both "type":"module"). No tsx, no bundling, no socket.io involved.
//
// Run: node scripts/web-22-verify.js   (plain Node >= 22.7; Node 20 teams:
//      node --import tsx scripts/web-22-verify.js)

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Suite, http, startServer, stopServer, wsClient } from "./_h.mjs";
import {
  ATTACHMENT_LIMIT_LABEL,
  MAX_ATTACHMENT_BYTES,
  MAX_TEXT_LENGTH,
  MESSAGE_KINDS,
  MIN_VOICE_SECONDS,
  OVER_LIMIT_ERROR,
  formatBytes,
  isMessageKind,
  mediaPreviewText,
  validateAttachment,
} from "../../../packages/shared/src/messages.ts";
import { buildRelaySendBody, sendRelayMessage } from "../../../packages/api-client/src/messages.ts";

const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (f) => fs.readFileSync(path.join(APP, f), "utf8");

const PORT = 3933;
const server = startServer(PORT);
await server.ready;
const s = new Suite("WEB 2.2 Message Sending Parity (text / image / voice)");

// ── shared canonical module (packages/shared/src/messages.ts) ──
s.section("shared source of truth (@wpt/shared)");
s.check("exactly the three allowed kinds, no web-only types", JSON.stringify(MESSAGE_KINDS) === JSON.stringify(["text", "image", "voice"]));
s.check("one shared cap = 100 MiB (104857600 bytes)", MAX_ATTACHMENT_BYTES === 100 * 1024 * 1024);
s.check("cap label renders as '100 MB'", ATTACHMENT_LIMIT_LABEL === "100 MB" && formatBytes(MAX_ATTACHMENT_BYTES) === "100 MB");
s.check("voice minimum = 1s parity (matches mobile rule)", MIN_VOICE_SECONDS === 1);
s.check("4000-char text max carried from the relay", MAX_TEXT_LENGTH === 4000);
s.check("over-limit validation fails with a clear, human error", (() => {
  const v = validateAttachment({ kind: "image", sizeBytes: MAX_ATTACHMENT_BYTES + 1, mimeType: "image/png" });
  return !v.ok && v.code === "attachment_too_large" && v.error === OVER_LIMIT_ERROR && v.error.includes("up to 100 MB") && v.error.includes("too large");
})());
s.check("voice too short (<1s) is rejected", (() => {
  const v = validateAttachment({ kind: "voice", sizeBytes: 100, mimeType: "audio/webm", durationSec: 0.4 });
  return !v.ok && v.code === "voice_too_short";
})());
s.check("wrong mime for the kind is rejected", (() => {
  const v = validateAttachment({ kind: "image", sizeBytes: 10, mimeType: "text/plain" });
  return !v.ok && v.code === "bad_mime";
})());
s.check("valid small image passes", validateAttachment({ kind: "image", sizeBytes: 10, mimeType: "image/png" }).ok === true);
s.check("valid voice (>=1s, audio mime) passes", validateAttachment({ kind: "voice", sizeBytes: 10, mimeType: "audio/webm", durationSec: 3 }).ok === true);
s.check("kind guard rejects 'video'/'file'", !isMessageKind("video") && !isMessageKind("file"));
s.check("media preview copy for the UI", mediaPreviewText("image") === "Image" && mediaPreviewText("voice") === "Voice message" && mediaPreviewText("text") === "text");

// ── api-client relay helpers (packages/api-client/src/messages.ts) ──
s.section("api-client relay helpers (@wpt/api-client)");
const clientMessagesSrc = read("../../packages/api-client/src/messages.ts");
const bodyText = buildRelaySendBody({ from: "mervin", type: "direct", to: "pravan", text: "hello" });
s.check("text body keeps the legacy relay contract", bodyText.kind === "text" && bodyText.text === "hello" && bodyText.dataUrl === undefined && bodyText.sizeBytes === undefined);
const bodyImg = buildRelaySendBody({ from: "mervin", type: "direct", to: "pravan", kind: "image", dataUrl: "data:image/png;base64,x", mimeType: "image/png", sizeBytes: 5 });
s.check("image body carries the attachment fields and empty text", bodyImg.kind === "image" && bodyImg.dataUrl === "data:image/png;base64,x" && bodyImg.mimeType === "image/png" && bodyImg.sizeBytes === 5 && bodyImg.text === "");
const noKind = buildRelaySendBody({ from: "mervin", type: "group", groupId: "project", text: "note" });
s.check("omitted kind defaults to text", noKind.kind === "text");
s.check("videos are never built on the send path", buildRelaySendBody({ from: "a", type: "direct", to: "b", kind: "video", text: "x" }).kind === "text");
s.check("relay module is a plain-fetch transport (no socket.io import, no /api/v1 coupling)", !clientMessagesSrc.includes("socket.io-client") && !/import[\s\S]*socket\.io/.test(clientMessagesSrc) && !clientMessagesSrc.includes('"/api/v1') && clientMessagesSrc.includes("/api/messages/send"));
const apiClientIndex = read("../../packages/api-client/src/index.ts");
s.check("relay helpers exported from the package index", apiClientIndex.includes("buildRelaySendBody") && apiClientIndex.includes("sendRelayMessage"));

// ── server pins the shared contract + rejects bad input ──
s.section("server enforcement (wpt-server.mjs)");
const serverSrc = read("server/wpt-server.mjs");
s.check("server uses the same 100 MiB constant", serverSrc.includes("MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024"));
s.check("server uses the same kinds list and voice minimum", serverSrc.includes('MESSAGE_KINDS = ["text", "image", "voice"]') && serverSrc.includes("MIN_VOICE_SECONDS = 1"));
s.check("server rejects explicit unknown kinds (no web-only types)", serverSrc.includes("bad_kind") && serverSrc.includes("Unsupported message kind."));
s.check("server over-limit error matches the shared copy", serverSrc.includes("up to 100 MB.") && OVER_LIMIT_ERROR.endsWith("up to 100 MB."));
s.check("server rejects short voices with clear copy", serverSrc.includes("voice_too_short") && serverSrc.includes("too short"));
s.check("server rejects wrong mimes with clear copy", serverSrc.includes("bad_mime") && serverSrc.includes("Unsupported file type"));
s.check("server rejects declared-size mismatches", serverSrc.includes("Attachment size does not match its payload."));
s.check("server caps the body with a 413 payload_too_large path", serverSrc.includes('Symbol("too_large")') && serverSrc.includes("payload_too_large"));
s.check("server serves stored media at /api/media/:id", serverSrc.includes("media[1]") && serverSrc.includes("attachments.get") && serverSrc.includes("Content-Length"));
s.check("server previews media in recent-chats", serverSrc.includes("mediaPreview"));

// ── web client composes from the shared rules, never persists payloads ──
s.section("web client (apps/web/app)");
const clientMessages = read("app/lib/messages.ts");
const appState = read("app/lib/app-state.ts");
s.check("client bridges @wpt/shared (single source of truth)", clientMessages.includes('from "@wpt/shared"') && clientMessages.includes("MAX_ATTACHMENT_BYTES") && clientMessages.includes("validateAttachment"));
s.check("client builds media URLs against the relay", clientMessages.includes("/api/media/") && clientMessages.includes("wptApiBase"));
s.check("client messages carry the media metadata", appState.includes("kind?: MessageKind") && appState.includes("attachmentId?") && appState.includes("sizeBytes?") && appState.includes("durationSec?"));
s.check("app-state never persists media payloads", !appState.includes("dataUrl"));
const chatApp = read("app/wpt/chat-app.tsx");
s.check("attach button is wired to an image file picker", chatApp.includes('accept="image/*"') && chatApp.includes('type="file"') && chatApp.includes("fileInputRef"));
s.check("voice notes use press-hold MediaRecorder + getUserMedia", chatApp.includes("MediaRecorder") && chatApp.includes("navigator.mediaDevices.getUserMedia") && chatApp.includes("setPointerCapture") && chatApp.includes("stopVoice"));
s.check("recording bar surfaces duration + discard", chatApp.includes("rec-bar") && chatApp.includes("rec-timer") && chatApp.includes("rec-cancel") && chatApp.includes("formatRecTime"));
s.check("image + voice bubbles render (pending state before the relay address lands)", chatApp.includes("b-img") && chatApp.includes("b-voice") && chatApp.includes("b-v-play") && chatApp.includes("b-media-pending") && chatApp.includes("Preparing…"));
s.check("compose-time validation uses the shared rules", chatApp.includes("validateAttachment") && chatApp.includes("showAttachError"));
const webApp = read("app/wpt/web-app.tsx");
s.check("orchestrator sends media with in-memory payloads", webApp.includes("mediaPayloadRef") && webApp.includes("sendMedia(") && webApp.includes("mediaPayloadRef.current.set(tmpMsg.id, attach.dataUrl)"));
s.check("outbox flush sends kind + attachment fields", webApp.includes("payload.kind = m.kind") && webApp.includes("payload.dataUrl = dataUrl"));
s.check("echo finalize copies the server's attachment metadata", webApp.includes("finalizeEcho") && webApp.includes("extra.mKind") && webApp.includes("extra.attachmentId"));
s.check("incoming + history map mKind/attachment fields", webApp.includes("isMessageKind(e.mKind)") && webApp.includes("sm.attachmentId"));
s.check("recent-chat previews use the shared media copy", webApp.includes("mediaPreviewText"));
s.check("web realtime stays socket.io-free", !webApp.includes("socket.io") && !read("app/lib/ws.ts").includes("socket.io"));

// ── dynamic: real pipeline sends/receives each kind ──
s.section("dynamic: live text/image/voice over the real relay");
const health = await http(PORT, "GET", "/api/health");
s.check("server is healthy on its own port", health.ok && health.json?.service === "WPT Chat");
const linkM = await http(PORT, "POST", "/api/mock/link-web", { userId: "mervin" });
const linkP = await http(PORT, "POST", "/api/mock/link-web", { userId: "pravan" });
s.check("two linked sessions (mervin + pravan) available", linkM.ok && typeof linkM.json?.webToken === "string" && linkP.ok && typeof linkP.json?.webToken === "string");
const mervinToken = String(linkM.json.webToken);
const pravanToken = String(linkP.json.webToken);

const base = `http://127.0.0.1:${PORT}`;
function bodyFor(partial) {
  return buildRelaySendBody(partial);
}

const textSend = await sendRelayMessage(base, bodyFor({ from: "mervin", type: "direct", to: "pravan", text: "parity text" }));
s.check("text send accepted + stored", textSend.ok && textSend.status === 200 && textSend.body?.message?.text === "parity text");
const histBefore = await http(PORT, "GET", "/api/messages/mervin/pravan");
s.check("text history entry keeps the legacy shape (no mKind/attachment)", Array.isArray(histBefore.json) && histBefore.json.some((m) => m.text === "parity text" && m.mKind === undefined && m.attachmentId === undefined));

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");
const pngDataUrl = `data:image/png;base64,${PNG_B64}`;
const VOICE_BYTES = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x86, 0x81, 0x01]);
const voiceDataUrl = `data:audio/webm;base64,${VOICE_BYTES.toString("base64")}`;

// Recipient connects BEFORE the media sends so the live broadcasts are received.
const recipient = wsClient(PORT, { webToken: pravanToken });
await recipient.ready;

const voiceSend = await sendRelayMessage(base, bodyFor({ from: "mervin", type: "direct", to: "pravan", kind: "voice", dataUrl: voiceDataUrl, mimeType: "audio/webm", sizeBytes: VOICE_BYTES.length, durationSec: 4 }));
s.check("voice send accepted + stored with kind + duration", voiceSend.ok && voiceSend.status === 200 && voiceSend.body?.message?.mKind === "voice" && voiceSend.body.message.durationSec === 4 && typeof voiceSend.body.message.attachmentId === "string");
const voiceAttId = String(voiceSend.body?.message?.attachmentId ?? "");

const imageSend = await sendRelayMessage(base, bodyFor({ from: "mervin", type: "direct", to: "pravan", kind: "image", dataUrl: pngDataUrl, mimeType: "image/png", sizeBytes: PNG_BYTES.length }));
s.check("image send accepted + stored with kind + size", imageSend.ok && imageSend.status === 200 && imageSend.body?.message?.mKind === "image" && imageSend.body.message.sizeBytes === PNG_BYTES.length && typeof imageSend.body.message.attachmentId === "string");
const imageAttId = String(imageSend.body?.message?.attachmentId ?? "");

const liveVoice = await recipient.waitEvent("message", { predicate: (e) => e.mKind === "voice" });
s.check("voice broadcast reaches the recipient live over WebSocket", liveVoice && liveVoice.from === "mervin" && liveVoice.kind === "direct" && liveVoice.attachmentId === voiceAttId && liveVoice.mimeType === "audio/webm" && liveVoice.sizeBytes === VOICE_BYTES.length && liveVoice.durationSec === 4);
const liveImage = await recipient.waitEvent("message", { predicate: (e) => e.mKind === "image" });
s.check("image broadcast reaches the recipient live over WebSocket", liveImage && liveImage.from === "mervin" && liveImage.kind === "direct" && liveImage.attachmentId === imageAttId && liveImage.mimeType === "image/png" && liveImage.sizeBytes === PNG_BYTES.length);

async function fetchMedia(id) {
  const res = await fetch(`${base}/api/media/${encodeURIComponent(id)}`, { cache: "no-store" });
  const ct = res.headers.get("content-type") || "";
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ct, buf };
}
const voiceMedia = await fetchMedia(voiceAttId);
s.check("voice attachment serves back the exact bytes as audio/*", voiceMedia.status === 200 && voiceMedia.ct === "audio/webm" && voiceMedia.buf.length === VOICE_BYTES.length && voiceMedia.buf.equals(VOICE_BYTES));
const imageMedia = await fetchMedia(imageAttId);
s.check("image attachment serves back the exact bytes as image/*", imageMedia.status === 200 && imageMedia.ct === "image/png" && imageMedia.buf.equals(PNG_BYTES));
const missingMedia = await fetchMedia("does-not-exist");
s.check("unknown media id is a 404, not garbage", missingMedia.status === 404);

const hist = await http(PORT, "GET", "/api/messages/mervin/pravan");
s.check("history holds all three kinds with attachment metadata", Array.isArray(hist.json) && hist.json.some((m) => m.mKind === "voice" && m.durationSec === 4 && m.attachmentId === voiceAttId) && hist.json.some((m) => m.mKind === "image" && m.sizeBytes === PNG_BYTES.length && m.attachmentId === imageAttId));
const recent = await http(PORT, "GET", "/api/recent-chats/mervin");
s.check("recent-chats previews the shared media copy for the last message", recent.ok && Array.isArray(recent.json?.items) && recent.json.items.some((i) => i.type === "direct" && i.id === "pravan" && i.preview === "Image"));

s.section("dynamic: clear rejections at the shared cap");
const overLimit = await sendRelayMessage(base, bodyFor({ from: "mervin", type: "direct", to: "pravan", kind: "image", dataUrl: pngDataUrl, mimeType: "image/png", sizeBytes: MAX_ATTACHMENT_BYTES + 1 }));
s.check("over-limit attachment rejected with 413 + clear error", overLimit.status === 413 && overLimit.body?.ok === false && typeof overLimit.body === "object" && overLimit.body !== null && !Array.isArray(overLimit.body) && String(overLimit.body.message ?? "").includes("up to 100 MB"));
const badKind = await http(PORT, "POST", "/api/messages/send", { from: "mervin", type: "direct", to: "pravan", kind: "video", text: "nope" });
s.check("explicit unknown kind (video) rejected 400 bad_kind", badKind.status === 400 && badKind.json?.error === "bad_kind");
const shortVoice = await http(PORT, "POST", "/api/messages/send", { from: "mervin", type: "direct", to: "pravan", kind: "voice", dataUrl: voiceDataUrl, mimeType: "audio/webm", sizeBytes: VOICE_BYTES.length, durationSec: 0.5 });
s.check("voice under 1s rejected 400 voice_too_short", shortVoice.status === 400 && shortVoice.json?.error === "voice_too_short");
const badMime = await http(PORT, "POST", "/api/messages/send", { from: "mervin", type: "direct", to: "pravan", kind: "image", dataUrl: pngDataUrl, mimeType: "text/plain", sizeBytes: PNG_BYTES.length });
s.check("kind/mime mismatch rejected 400 bad_mime", badMime.status === 400 && badMime.json?.error === "bad_mime");
const sizeMismatch = await http(PORT, "POST", "/api/messages/send", { from: "mervin", type: "direct", to: "pravan", kind: "image", dataUrl: pngDataUrl, mimeType: "image/png", sizeBytes: 7 });
s.check("declared-size mismatch rejected 400 bad_size", sizeMismatch.status === 400 && sizeMismatch.json?.error === "bad_size");

recipient.close();
s.summary();
stopServer(server);
process.exit(s.failed === 0 ? 0 : 1);