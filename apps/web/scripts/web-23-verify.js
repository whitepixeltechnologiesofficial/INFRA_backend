// WEB 2.3 — Read Receipts + Typing Indicators + In-thread Search verification.
//
// Stretch-goal proof over the REAL live pipeline (each suite owns its
// wpt-server.mjs on a unique port):
//
//   * four-state message status (sent -> delivered -> read, plus terminal
//     failed) transitioned exactly like the mobile spec — the pure machine is
//     asserted directly AND driven by live events (send 200 = echo,
//     relay refusal = rejection, read broadcast = read);
//   * read receipts: POST /api/messages/read marks read-through to the
//     reported id, broadcasts {type:'read', messageIds:[...]} to the senders'
//     live sockets, and unknown ids are rejected;
//   * typing indicators: POST /api/messages/typing broadcasts typing:true to
//     the peer socket, an explicit typing:false clears immediately, and a
//     TYPING_TTL_MS override proves the server auto-cleans a typist who went
//     quiet without sending (harness TTL = 400ms);
//   * in-thread search across a 50+ message thread returns the correct
//     matches (case-insensitive, regex metacharacters escaped) against real
//     relay history, per the shared pure search module.
//
// Shared chips imported as real TS source (Node type stripping): realtime.ts,
// receipts.ts, search.ts. No tsx, no bundling, no socket.io.
//
// Run: node scripts/web-23-verify.js   (plain Node >= 22.7;
//      node --import tsx scripts/web-23-verify.js)

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Suite, http, startServer, stopServer, wsClient } from "./_h.mjs";
import { READ_ROUTE, TYPING_DISPLAY_MS, TYPING_ROUTE, TYPING_TTL_MS, typingDisplayMs, typingTtlMs } from "../../../packages/shared/src/realtime.ts";
import {
  RECEIPT_EVENTS,
  RECEIPT_STATUSES,
  applyReadReceipt,
  buildReadRequest,
  isReceiptStatus,
  lastPeerMessage,
  nextMessageStatus,
} from "../app/lib/receipts.ts";
import { buildSearchPattern, chooseMatchIndexes, escapeRegExp, splitHighlight, stepMatchIndex } from "../app/lib/search.ts";

const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (f) => fs.readFileSync(path.join(APP, f), "utf8");

// One shared 53-message thread for BOTH the pure fixture and the live relay.
// Exactly 7 rows match "alpha" case-insensitively; no other row does; the rest
// assert escaping of regex metacharacters.
function makeThread() {
  const t = [];
  for (let i = 0; i < 53; i++) t.push({ text: `plain msg-${i}` });
  t[5] = { text: "alpha is easy" };
  t[12] = { text: "alpha marker two" };
  t[20] = { text: "The Alpha Protocol" };
  t[27] = { text: "ALPHA lowercase check" };
  t[33] = { text: "alpha" };
  t[41] = { text: "oneALPHA two" };
  t[49] = { text: "final alpha test" };
  return t;
}
const ALPHA_ROWS = [5, 12, 20, 27, 33, 41, 49];

const PORT = 3944;
const server = startServer(PORT, { typingTtlMs: 400 });
await server.ready;
const s = new Suite("WEB 2.3 Read Receipts + Typing Indicators + In-thread Search");

// ── shared canonical timing (@wpt/shared/src/realtime.ts) ──
s.section("shared realtime constants (@wpt/shared)");
s.check("typing TTL default = 5000ms (single source of truth)", TYPING_TTL_MS === 5000 && typingTtlMs() === 5000);
s.check("client display safety ceiling = 2500ms", TYPING_DISPLAY_MS === 2500 && typingDisplayMs() === 2500);
s.check("read-receipt REST route is /api/messages/read", READ_ROUTE === "/api/messages/read");
s.check("typing REST route is /api/messages/typing", TYPING_ROUTE === "/api/messages/typing");
const realtimeIndex = read("../../packages/shared/src/index.ts");
s.check("realtime module exported from the package index", realtimeIndex.includes('export * from "./realtime.js";'));

// ── pure four-state machine (app/lib/receipts.ts) ──
s.section("four-state status machine (app/lib/receipts.ts)");
s.check("exactly the four mobile statuses, no extra web states", JSON.stringify(RECEIPT_STATUSES) === JSON.stringify(["sent", "delivered", "failed", "read"]));
s.check("events are echo / rejected / read", JSON.stringify(RECEIPT_EVENTS) === JSON.stringify(["echo", "rejected", "read"]));
s.check("echo moves sent -> delivered", nextMessageStatus("sent", "echo") === "delivered");
s.check("read moves delivered -> read", nextMessageStatus("delivered", "read") === "read");
s.check("read moves sent -> read (read while still echoing is legitimate)", nextMessageStatus("sent", "read") === "read");
s.check("rejected makes sent -> failed (terminal)", nextMessageStatus("sent", "rejected") === "failed");
s.check("rejected makes delivered -> failed", nextMessageStatus("delivered", "rejected") === "failed");
s.check("failed is terminal: echo cannot resurrect it", nextMessageStatus("failed", "echo") === "failed");
s.check("failed is terminal: read cannot resurrect it", nextMessageStatus("failed", "read") === "failed");
s.check("read state never downgrades on a late echo", nextMessageStatus("read", "echo") === "read");
s.check("status guard accepts exactly the four", isReceiptStatus("sent") && isReceiptStatus("delivered") && isReceiptStatus("failed") && isReceiptStatus("read") && !isReceiptStatus("seen") && !isReceiptStatus("typing"));
s.check("buildReadRequest (direct) carries to + messageId", (() => {
  const b = buildReadRequest({ from: "pravan", isGroup: false, to: "mervin", messageId: "m1" });
  return b.from === "pravan" && b.type === "direct" && b.to === "mervin" && b.messageId === "m1" && b.groupId === undefined;
})());
s.check("buildReadRequest (group) carries groupId, never to", (() => {
  const b = buildReadRequest({ from: "pravan", isGroup: true, groupId: "project", messageId: "g1" });
  return b.type === "group" && b.groupId === "project" && b.to === undefined && b.messageId === "g1";
})());
s.check("applyReadReceipt elevates only my own outbound messages", (() => {
  const hist = [
    { id: "a", from: "mervin", status: "delivered" },
    { id: "b", from: "pravan", status: "delivered" },
    { id: "c", from: "mervin", status: "sent" },
  ];
  const changed = applyReadReceipt(hist, ["a", "b", "c"], "mervin");
  return changed === 2 && hist[0].status === "read" && hist[1].status === "delivered" && hist[2].status === "read";
})());
s.check("applyReadReceipt never downgrades a failed message", (() => {
  const hist = [{ id: "x", from: "mervin", status: "failed" }];
  return applyReadReceipt(hist, ["x"], "mervin") === 0 && hist[0].status === "failed";
})());
s.check("lastPeerMessage never returns a message I wrote", (() => {
  const list = [{ id: "1", from: "mervin" }, { id: "2", from: "pravan" }, { id: "3", from: "mervin" }];
  const lp = lastPeerMessage(list, "mervin");
  return lp !== null && lp.id === "2";
})());
s.check("lastPeerMessage is null when everything is mine", lastPeerMessage([{ id: "1", from: "mervin" }], "mervin") === null);

// ── pure search core (app/lib/search.ts) ──
s.section("in-thread search core (app/lib/search.ts)");
s.check("regex metacharacters are escaped in queries", escapeRegExp("a.b*?") === "a\\.b\\*\\?" && escapeRegExp("[x]") === "\\[x\\]");
s.check("empty / whitespace query builds no pattern", buildSearchPattern("  ") === null && buildSearchPattern("") === null);
s.check("pattern is case-insensitive capture-group shape", (() => {
  const p = buildSearchPattern("alpha");
  return p !== null && p.source === "(alpha)" && p.flags === "i";
})());
const fixture = makeThread();
const idxAlpha = chooseMatchIndexes(fixture, buildSearchPattern("alpha"));
s.check("53-message fixture: alpha query finds exactly the seeded 7 rows", (() => {
  if (idxAlpha.length !== 7) return false;
  return ALPHA_ROWS.every((i) => idxAlpha.includes(i)) && idxAlpha.every((i) => fixture[i].text.toLowerCase().includes("alpha"));
})());
s.check("escaped '?' matches only a literal R&D(alpha)? row", (() => {
  const t = [{ text: "R&D(alpha)? handled" }, { text: "RDalphaX" }, { text: "alpha)" }];
  return chooseMatchIndexes(t, buildSearchPattern("R&D(alpha)?")).length === 1;
})());
s.check("escaped '.' never matches wildcard lookalikes", (() => {
  const t = [{ text: "x a.b y" }, { text: "x axb y" }, { text: "x aXb y" }];
  const hits = chooseMatchIndexes(t, buildSearchPattern("a.b"));
  return hits.length === 1 && hits[0] === 0;
})());
s.check("splitHighlight keeps matched fragments at odd indexes", (() => {
  const parts = splitHighlight("cost 100 a.b then", buildSearchPattern("a.b"));
  return parts[1] === "a.b" && parts.join("") === "cost 100 a.b then" && parts.filter((_, i) => i % 2 === 1).length === 1;
})());
s.check("splitHighlight with no pattern returns the raw text", splitHighlight("plain", null).join("") === "plain");
s.check("stepMatchIndex wraps forward and backward", stepMatchIndex(2, 3, 1) === 0 && stepMatchIndex(0, 3, -1) === 2 && stepMatchIndex(0, 0, 1) === 0);

// ── server wiring ──
s.section("server wiring (wpt-server.mjs)");
const serverSrc = read("server/wpt-server.mjs");
s.check("server default TYPING TTL pins the shared 5000", serverSrc.includes("TYPING_TTL_MS") && serverSrc.includes("|| 5000"));
s.check("server implements POST /api/messages/read", serverSrc.includes('"/api/messages/read"') && serverSrc.includes("readIds"));
s.check("server broadcasts the read receipt to senders", serverSrc.includes('{ type: "read"'));
s.check("server rejects an unknown read message with read_not_found", serverSrc.includes("404") && serverSrc.includes("read_not_found"));
s.check("server tracks the read-through position per reader", serverSrc.includes("reads.set"));
s.check("server implements POST /api/messages/typing", serverSrc.includes('"/api/messages/typing"'));
s.check("server broadcasts typing on AND off with the peer context", serverSrc.includes('{ type: "typing"') && serverSrc.includes("payload.from") && serverSrc.includes("payload.to"));
s.check("server auto-clears a quiet typist (TTL timer)", serverSrc.includes("scheduleTypingClear") && serverSrc.includes("typingTimers") && serverSrc.includes("clearTypingTimer"));
s.check("typing on/off both reach the user rooms (live Web sockets)", serverSrc.includes("broadcast(`user:${from}`, payload)") && serverSrc.includes("broadcast(`user:${to}`, payload)"));
s.check("read/typing are additive: the text-send relay contract is untouched", serverSrc.includes("msg = { id: Date.now() + Math.random(), from, text: trimmed.slice(0, MAX_TEXT_LENGTH), time: now() };"));

// ── client wiring ──
s.section("client wiring (apps/web/app)");
const webApp = read("app/wpt/web-app.tsx");
const chatApp = read("app/wpt/chat-app.tsx");
s.check("orchestrator handles read + typing socket events", webApp.includes('case "read":') && webApp.includes('case "typing":'));
s.check("orchestrator elevates outbound messages via the shared machine", webApp.includes("applyReadReceipt") && webApp.includes("nextMessageStatus"));
s.check("orchestrator reports read-through on open + on live message", webApp.includes("lastPeerMessage") && webApp.includes("reportRead("));
s.check("orchestrator ignores a peer's typing for the local context", webApp.includes("uid === s.userId") && webApp.includes("chatByPeerIfExists"));
s.check("orchestrator posts read/typing over REST only (no ws writes)", webApp.includes('"POST", READ_ROUTE') && webApp.includes('"POST", TYPING_ROUTE'));
s.check("chat render passes the typing side-channel through", webApp.includes("peerTyping={peerTyping}") && webApp.includes("onTyping={sendTyping}"));
s.check("chat-app renders a live typing row above the composer", chatApp.includes('className="typing"') && chatApp.includes("typing-dot") && chatApp.includes("peerTyping[activeChat.id]"));
s.check("chat-app announces typing on draft change and stops on send/switch", chatApp.includes("onTyping(chatId, true)") && chatApp.includes("onTyping(activeChat.id, false)"));
s.check("chat-app search delegates to the shared search module", chatApp.includes("buildSearchPattern") && chatApp.includes("chooseMatchIndexes") && chatApp.includes("splitHighlight") && chatApp.includes("stepMatchIndex"));
s.check("chat-app no longer hand-rolls regex escaping (single source)", !chatApp.includes("[.*+?^${}()|[\\]\\\\]"));
for (const f of ["app/wpt/web-app.tsx", "app/wpt/chat-app.tsx", "app/lib/ws.ts"]) {
  const text = read(f);
  s.check(`no sync/progress UI tokens regressed in ${path.basename(f)}`, !/spinner|snackbar|toast/.test(text) && !text.includes("loading="));
}

// ── dynamic: live read receipts over the real relay ──
s.section("dynamic: live read receipts over the real relay");
const health = await http(PORT, "GET", "/api/health");
s.check("server is healthy on its own port", health.ok && health.json?.service === "WPT Chat");
const linkM = await http(PORT, "POST", "/api/mock/link-web", { userId: "mervin" });
const linkP = await http(PORT, "POST", "/api/mock/link-web", { userId: "pravan" });
s.check("two linked sessions (mervin + pravan) available", linkM.ok && typeof linkM.json?.webToken === "string" && linkP.ok && typeof linkP.json?.webToken === "string");
const mToken = String(linkM.json.webToken);
const pToken = String(linkP.json.webToken);

const mervin = wsClient(PORT, { webToken: mToken }); // sender/reader target
const pravan = wsClient(PORT, { webToken: pToken }); // reader/typer
await mervin.ready;
await pravan.ready;

const sent = await http(PORT, "POST", "/api/messages/send", { from: "mervin", type: "direct", to: "pravan", text: "read receipt target" });
s.check("text send accepted + stored", sent.ok && sent.status === 200 && typeof sent.json?.message?.id !== "undefined");
const sentId = String(sent.json?.message?.id ?? "");
let status = nextMessageStatus("sent", "echo");
s.check("the sender's machine: sent -> delivered on the relay echo", status === "delivered");

const delivered = await pravan.waitEvent("message", { predicate: (e) => e.text === "read receipt target" });
s.check("reader received the message live over WebSocket", delivered && delivered.from === "mervin");

const readResp = await http(PORT, "POST", "/api/messages/read", { from: "pravan", type: "direct", to: "mervin", messageId: sentId });
s.check("reader reports read -> 200 with the resolved ids", readResp.ok && readResp.status === 200 && readResp.json?.ok === true && readResp.json?.read >= 1);
const readEvt = await mervin.waitEvent("read", { predicate: (e) => e.from === "pravan" && e.to === "mervin" && Array.isArray(e.messageIds) });
s.check("sender receives the live read broadcast", readEvt !== null);
s.check("read broadcast carries the reported message id in messageIds", Array.isArray(readEvt?.messageIds) && readEvt.messageIds.includes(sentId));
status = nextMessageStatus(status, "read");
s.check("the sender's machine: delivered -> read on the read receipt", status === "read");

s.section("dynamic: read-receipt rejections");
const unknownRead = await http(PORT, "POST", "/api/messages/read", { from: "pravan", type: "direct", to: "mervin", messageId: "no-such-message" });
s.check("unknown message id is 404 read_not_found", unknownRead.status === 404 && unknownRead.json?.error === "read_not_found");
const badReaderRead = await http(PORT, "POST", "/api/messages/read", { from: "ghost", type: "direct", to: "mervin", messageId: sentId });
s.check("unknown reader is rejected 400 bad_read", badReaderRead.status === 400 && badReaderRead.json?.error === "bad_read");

s.section("dynamic: group read receipts");
const gSent = await http(PORT, "POST", "/api/messages/send", { from: "mervin", type: "group", groupId: "project", text: "group read target" });
s.check("group text send accepted", gSent.ok && gSent.status === 200);
const gId = String(gSent.json?.message?.id ?? "");
const gDelivered = await pravan.waitEvent("message", { predicate: (e) => e.text === "group read target" });
s.check("group message reached the member live", gDelivered && gDelivered.groupId === "project");
const gRead = await http(PORT, "POST", "/api/messages/read", { from: "pravan", type: "group", groupId: "project", messageId: gId });
s.check("group read accepted with the sender's message resolved", gRead.ok && gRead.status === 200 && gRead.json?.read >= 1);
const gEvt = await mervin.waitEvent("read", { predicate: (e) => e.from === "pravan" && e.groupId === "project" && Array.isArray(e.messageIds) });
s.check("group read broadcast reaches the sender with messageIds", gEvt !== null && gEvt.messageIds.includes(gId));
const gMissing = await http(PORT, "POST", "/api/messages/read", { from: "pravan", type: "group", groupId: "project", messageId: "nope" });
s.check("unknown group message is 404 read_not_found", gMissing.status === 404);

s.section("dynamic: live typing indicators");
const tyOn = await http(PORT, "POST", "/api/messages/typing", { from: "pravan", type: "direct", to: "mervin", typing: true });
s.check("typing:true accepted", tyOn.ok && tyOn.status === 200 && tyOn.json?.typing === true);
const tyTrueEvt = await mervin.waitEvent("typing", { predicate: (e) => e.from === "pravan" && e.typing === true });
s.check("peer socket receives typing:true live", tyTrueEvt !== null && tyTrueEvt.kind === "direct");
const tyOff = await http(PORT, "POST", "/api/messages/typing", { from: "pravan", type: "direct", to: "mervin", typing: false });
s.check("typing:false accepted (explicit clear)", tyOff.ok && tyOff.status === 200 && tyOff.json?.typing === false);
const tyFalseEvt = await mervin.waitEvent("typing", { predicate: (e) => e.from === "pravan" && e.typing === false });
s.check("explicit typing:false clears immediately", tyFalseEvt !== null);
const unknownTyper = await http(PORT, "POST", "/api/messages/typing", { from: "ghost", type: "direct", to: "mervin", typing: true });
s.check("unknown typer is rejected 400 bad_typing", unknownTyper.status === 400 && unknownTyper.json?.error === "bad_typing");

s.section("dynamic: typing auto-clear after the TTL (no message sent)");
mervin.events.length = 0;
await http(PORT, "POST", "/api/messages/typing", { from: "pravan", type: "direct", to: "mervin", typing: true });
const t0 = Date.now();
const tyAutoOff = await mervin.waitEvent("typing", { predicate: (e) => e.from === "pravan" && e.typing === false, timeout: 3000 });
const elapsed = Date.now() - t0;
s.check("quiet typist auto-clears via the server TTL (no typing:false posted)", tyAutoOff !== null);
s.check("auto-clear fired at/after the harness TTL (400ms), not instantly", elapsed >= 300 && elapsed < 2900);
const noSpurious = await mervin.expectNoEvent("typing", { within: 600 });
s.check("no further typing events after the auto-clear", noSpurious === true);

s.section("dynamic: in-thread search over a 50+ message thread");
for (const t of makeThread()) {
  await http(PORT, "POST", "/api/messages/send", { from: "mervin", type: "direct", to: "pravan", text: t.text });
}
const hist = await http(PORT, "GET", "/api/messages/mervin/pravan");
s.check("history reflects all 53 search messages (thread exceeds 50)", Array.isArray(hist.json) && hist.json.length >= 55);
const alphaHits = chooseMatchIndexes(hist.json, buildSearchPattern("alpha"));
s.check("live 55-message thread: alpha query matches the seeded rows only", (() => {
  return alphaHits.length === 7 && alphaHits.every((i) => String(hist.json[i].text).toLowerCase().includes("alpha"));
})());

const preQuery = await http(PORT, "POST", "/api/messages/send", { from: "mervin", type: "direct", to: "pravan", text: "R&D(alpha)? never again" });
const postQuery = await http(PORT, "POST", "/api/messages/send", { from: "mervin", type: "direct", to: "pravan", text: "cost a.b then axb aXb" });
s.check("special-char probe messages accepted", preQuery.ok && postQuery.ok);
const hist2 = await http(PORT, "GET", "/api/messages/mervin/pravan");
s.check("hist2 confirms the 57-message thread", Array.isArray(hist2.json) && hist2.json.length === 57);
const specialHits = chooseMatchIndexes(hist2.json, buildSearchPattern("R&D(alpha)?"));
s.check("escaped query over relay history matches only the literal probe row", specialHits.length === 1 && String(hist2.json[specialHits[0]].text).includes("R&D(alpha)?"));
const dotHits = chooseMatchIndexes(hist2.json, buildSearchPattern("a.b"));
s.check("escaped '.' over relay history matches only the literal a.b row", (() => {
  if (dotHits.length !== 1) return false;
  const withDot = hist2.json.map((m) => String(m.text)).filter((t) => t.includes("a.b"));
  return withDot.length === 1 && withDot[0] === String(hist2.json[dotHits[0]].text);
})());
const highlightParts = splitHighlight("cost a.b then axb", buildSearchPattern("a.b"));
s.check("splitHighlight renders only the literal segment as a match", highlightParts[1] === "a.b" && highlightParts.length === 3);
const alphaCount = chooseMatchIndexes(hist2.json, buildSearchPattern("alpha")).length;
s.check("search returns the true N-of-N count across the full thread", alphaCount === 8);
const wrap = stepMatchIndex(alphaCount - 1, alphaCount, 1);
s.check("prev/next steps wrap within the match set", wrap === 0);

s.section("dynamic: live rejection maps to the terminal failed state");
const rejected = await http(PORT, "POST", "/api/messages/send", { from: "mervin", type: "direct", to: "no-such-user", text: "x" });
s.check("relay refuses an unknown recipient (404 user_not_found)", rejected.status === 404 && rejected.json?.error === "user_not_found");
s.check("the machine: any rejection is terminal failed", nextMessageStatus("sent", "rejected") === "failed" && nextMessageStatus("delivered", "rejected") === "failed");

mervin.close();
pravan.close();
s.summary();
stopServer(server);
process.exit(s.failed === 0 ? 0 : 1);