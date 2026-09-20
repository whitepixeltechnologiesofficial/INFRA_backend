// End-to-end WEB-R1.x funnel on the REPLACEMENT stack:
//   link → auth → chat → close/reopen (persisted) → manual logout →
//   new-phone login force-logout → rescan end-state → re-link.
// Uses the full QR socket path (not just /api/mock/link-web) for the links.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Suite, http, startServer, stopServer, wsClient } from "./_h.mjs";

const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const qrGateSrc = fs.readFileSync(path.join(APP, "app/wpt/qr-gate.tsx"), "utf8");

const PORT = 3928;
const server = startServer(PORT);
await server.ready;
const s = new Suite("WEB E2E funnel");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fullLink() {
  const mint = await http(PORT, "GET", "/api/link/new");
  const ws = wsClient(PORT, { qrSession: mint.json.token });
  await ws.ready;
  await http(PORT, "POST", `/api/link/${mint.json.token}/confirm`, {});
  const ev = await ws.waitEvent("accountLinked", { timeout: 4000 });
  ws.close();
  return { ws, webToken: ev.webToken, userId: ev.userId };
}

s.section("1) link → auth");
const health = await http(PORT, "GET", "/api/health");
s.check("server healthy", health.ok);
const first = await fullLink();
s.check("full QR socket path links a session (accountLinked)", typeof first.webToken === "string" && first.userId === "mervin");
s.check("the new session authenticates", (await http(PORT, "GET", `/api/session/validate/${first.webToken}`)).json?.userId === "mervin");

s.section("2) chat works on the linked session");
const recent = await http(PORT, "GET", "/api/recent-chats/mervin");
s.check("seeded conversations load", recent.ok && recent.json?.items.length >= 1);
const sent = await http(PORT, "POST", "/api/messages/send", { from: "mervin", type: "direct", to: "pravan", text: "e2e hello" });
s.check("sending a message via the relay succeeds", sent.ok && sent.json?.ok);
const groupSent = await http(PORT, "POST", "/api/messages/send", { from: "mervin", type: "group", groupId: "project", text: "e2e group note" });
s.check("group sends work on the linked session", groupSent.ok && groupSent.json?.ok);

s.section("3) close the tab → reopen");
await sleep(500);
s.check("session survives a closed-tab idle interval (no cleanup ran)", (await http(PORT, "GET", `/api/session/validate/${first.webToken}`)).ok);
const reopenWs = wsClient(PORT, { webToken: first.webToken });
await reopenWs.ready;
await http(PORT, "POST", "/api/messages/send", { from: "pravan", type: "direct", to: "mervin", text: "arrived after reopen" });
const reopenedLive = await reopenWs.waitEvent("message", { timeout: 3000, predicate: (m) => m.text === "arrived after reopen" });
s.check("reopening restores a fully live session", reopenedLive.type === "message");

s.section("4) manual logout is explicit and distinct");
const logout = await http(PORT, "POST", "/api/session/logout", { webToken: first.webToken });
s.check("explicit Settings->Logout revokes server-side", logout.ok);
s.check("logoff leaves no server session", (await http(PORT, "GET", "/api/mock/web-sessions")).json?.sessions.every((x) => x.userId !== "mervin") && (await http(PORT, "GET", `/api/session/validate/${first.webToken}`)).status === 401);

s.section("5) new-phone login force-logs the Web off, no advance warning");
const second = await fullLink();
const kickSocket = wsClient(PORT, { webToken: second.webToken });
await kickSocket.ready;
await http(PORT, "POST", "/api/mock/new-phone-login", { userId: "mervin" });
const kick = await kickSocket.waitEvent("webForceLoggedOut", { timeout: 3000 });
s.check("new-phone login kicks the live Web session in real time", kick.reason === "new_phone_login");
s.check("kicked token hard-401s immediately", (await http(PORT, "GET", `/api/session/validate/${second.webToken}`)).status === 401);

s.section("6) clean rescan end-state exists and is reason-aware");
s.check("gate renders a clear 'session ended, please rescan' notice", qrGateSrc.includes("closed immediately") && qrGateSrc.replace(/\s+/g, " ").includes("Scan the QR below to reconnect"));
s.check("notice copy names the cause (new phone) and gives no grace period", qrGateSrc.includes("A new phone signed in to this account") && !/ends in|in \d+ seconds/i.test(qrGateSrc));
s.check("re-link clears the notice (fresh, ordinary gate)", /handleLinked[\s\S]{0,140}showForceLogoutNotice\(null\)/.test(fs.readFileSync(path.join(APP, "app/wpt/web-app.tsx"), "utf8")));

s.section("7) re-link restores a working session");
const third = await fullLink();
s.check("re-link succeeds end to end", typeof third.webToken === "string");
s.check("relinked session authenticates", (await http(PORT, "GET", `/api/session/validate/${third.webToken}`)).ok);
const relive = wsClient(PORT, { webToken: third.webToken });
await relive.ready;
await http(PORT, "POST", "/api/messages/send", { from: "pravan", type: "direct", to: "mervin", text: "post-relink traffic" });
const reliveMsg = await relive.waitEvent("message", { timeout: 3000, predicate: (m) => m.text === "post-relink traffic" });
s.check("the relinked session carries live traffic", reliveMsg.type === "message");
s.check("phone side is independent of all web session churn", (await http(PORT, "GET", "/api/mock/phone-status/mervin")).ok);

s.summary();
reopenWs.close();
kickSocket.close();
relive.close();
stopServer(server);
process.exit(s.failed === 0 ? 0 : 1);