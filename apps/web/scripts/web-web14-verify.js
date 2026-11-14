// WEB-R1.4 verification — the session survives the phone going offline; sends
// are backend-mediated (relayed) while offline; only a 401 logs the Web out.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { Suite, http, startServer, stopServer, wsClient } from "./_h.mjs";

const require = createRequire(import.meta.url);
const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const clientFiles = [
  "app/lib/web-session.ts",
  "app/lib/app-state.ts",
  "app/lib/api.ts",
  "app/lib/ws.ts",
  "app/lib/outbox-client.ts",
  "app/wpt/web-app.tsx",
  "app/wpt/qr-gate.tsx",
  "app/wpt/chat-app.tsx",
  "app/page.tsx",
  "app/layout.tsx",
];
const read = (rel) => fs.readFileSync(path.join(APP, rel), "utf8");
const allClient = clientFiles.map(read).join("\n");

const PORT = 3923;
const server = startServer(PORT);
await server.ready;
const s = new Suite("WEB-R1.4 verify (30)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

s.section("storage contract (persisted, tab-scoped storage never used)");
s.check("session key wpt_web_session_v1 is used", allClient.includes("wpt_web_session_v1"));
s.check("session lives in localStorage", allClient.includes("localStorage"));
s.check("sessionStorage is never used", !/window\.sessionStorage|(?:^|[^\w'"`])sessionStorage\s*\./.test(allClient));
s.check("chat state key wpt_web_app_state_v1 is used", allClient.includes("wpt_web_app_state_v1"));
s.check("outbox key wpt_web_outbox_v1 is used", allClient.includes("wpt_web_outbox_v1"));

s.section("lifecycle source-guard");
s.check("visibilitychange returns while hidden (no cleanup on tab background/close)", allClient.includes("if (document.hidden) return"));
s.check("no beforeunload/pagehide/unload handler anywhere", !/addEventListener\(\s*['"](?:beforeunload|pagehide|unload)['"]|on(?:beforeunload|pagehide|unload)\s*=/.test(allClient));
s.check("clearWebSession() has exactly 2 call sites (manual logout + performSessionLogout)", (allClient.match(/clearWebSession\(\);/g) || []).length === 2);
s.check("manual logout calls POST /api/session/logout", allClient.includes('"/api/session/logout"'));
s.check("401 from validate maps to performSessionLogout('revoked')", allClient.includes('"revoked"') && allClient.includes("performSessionLogout("));

s.section("outbox module (lib/wptOutbox.js) — offline-safe queue contract");
const lib = require("../lib/wptOutbox.js");
let storage = [];
const box = lib.createOutbox(() => storage, (v) => {
  storage = v;
});
box.enqueue({ id: "m1", chatId: "pravan", from: "mervin", to: "pravan", text: "hello offline" });
s.check("enqueue registers a pending entry", box.byId("m1")?.status === "pending" && box.pending().length === 1);
box.enqueue({ id: "m1", chatId: "pravan", from: "mervin", to: "pravan", text: "dup" });
s.check("enqueue dedupes by message id", box.pending().length === 1);
s.check("pending() lists only pending", box.pending().every((m) => m.status === "pending"));
box.markFailed("m1");
s.check("failed() lists failures", box.failed().length === 1 && box.byId("m1")?.status === "failed");
s.check("markFailed bumps attempts", box.byId("m1")?.attempts === 1);
box.retry("m1");
s.check("retry() moves failed back to pending", box.byId("m1")?.status === "pending");
box.markSent("m1");
s.check("markSent() removes the delivered entry", box.byId("m1") === null && box.count().pending === 0);
box.enqueue({ id: "m2", chatId: "project", from: "mervin", to: null, text: "group note" });
box.enqueue({ id: "m3", chatId: "project", from: "mervin", to: null, text: "also" });
box.markFailed("m3");
s.check("count() totals pending+failed", box.count().pending === 1 && box.count().failed === 1);
box.clear();
s.check("clear() empties the queue", box.count().pending === 0 && box.count().failed === 0);
storage = [];
box.enqueue({ id: "m4", chatId: "pravan", from: "mervin", to: "pravan", text: "roundtrip" });
const box2 = lib.createOutbox(() => storage, (v) => {
  storage = v;
});
s.check("persistence round-trip: a reloaded outbox sees queued sends", box2.byId("m4")?.text === "roundtrip" && box2.pending().length === 1);

s.section("dynamic: phone offline never ends the Web session");
const link = await http(PORT, "POST", "/api/mock/link-web", { userId: "mervin" });
const wt = link.json?.webToken;
s.check("headless link mints a web session", link.ok && typeof wt === "string");
s.check("session valid before phone goes offline", (await http(PORT, "GET", `/api/session/validate/${wt}`)).ok);

await http(PORT, "POST", "/api/mock/phone-offline", { userId: "mervin" });
const offStatus = await http(PORT, "GET", "/api/mock/phone-status/mervin");
s.check("phone offline reported", offStatus.json?.online === false);

const relay = await http(PORT, "POST", "/api/messages/send", { from: "mervin", type: "direct", to: "pravan", text: "while the phone is offline" });
s.check("backend-mediated send from Web accepted while phone offline", relay.ok && relay.json?.ok);
const pair = await http(PORT, "GET", "/api/messages/mervin/pravan");
s.check("relayed message stored server-side", pair.ok && pair.json.some((m) => m.text === "while the phone is offline"));
const recent = await http(PORT, "GET", "/api/recent-chats/mervin");
s.check("recent-chats preview reflects the relayed send", recent.json?.items.some((i) => i.preview === "while the phone is offline"));

const ws = wsClient(PORT, { webToken: wt });
await ws.ready;
await http(PORT, "POST", "/api/mock/phone-online", { userId: "mervin" });
const onStatus = await http(PORT, "GET", "/api/mock/phone-status/mervin");
s.check("phone back online", onStatus.json?.online === true);
await http(PORT, "POST", "/api/mock/phone-message", { userId: "mervin", text: "live inbound while online" });
const live = await ws.waitEvent("mockIncomingMessage", { timeout: 4000 });
s.check("live inbound arrives over the socket once back online", live.text === "live inbound while online");
s.check("session still valid after offline+online cycles", (await http(PORT, "GET", `/api/session/validate/${wt}`)).ok);

s.section("only a 401 logs the Web out");
await http(PORT, "POST", "/api/mock/new-phone-login", { userId: "mervin" });
const revokedValidation = await http(PORT, "GET", `/api/session/validate/${wt}`);
s.check("revocation is a hard 401 — the phone going offline never was", revokedValidation.status === 401);

if (s.summary()) {
  ws.close();
  stopServer(server);
  process.exit(0);
}
ws.close();
stopServer(server);
process.exit(1);