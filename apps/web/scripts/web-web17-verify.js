// WEB-R1.8 — new/other-device login force-logs every active Web session off
// IMMEDIATELY, with a clear "session ended, please rescan" end-state and NO
// grace period/advance warning. Static checks target the replacement sources;
// dynamic checks kick real live sockets in real time.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Suite, http, startServer, stopServer, wsClient } from "./_h.mjs";

const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const clientFiles = ["app/lib/web-session.ts", "app/lib/outbox-client.ts", "app/wpt/web-app.tsx", "app/wpt/qr-gate.tsx", "app/wpt/chat-app.tsx"];
const allClient = clientFiles.map((f) => fs.readFileSync(path.join(APP, f), "utf8")).join("\n");
const serverSrc = fs.readFileSync(path.join(APP, "server/wpt-server.mjs"), "utf8");

const PORT = 3927;
const server = startServer(PORT);
await server.ready;
const s = new Suite("WEB-R1.8 verify (29)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

s.section("backend: invalidation is a real-time broadcast with a reason, no grace period");
s.check("invalidateWebForUser clears every session for the user synchronously", serverSrc.includes("function invalidateWebForUser") && serverSrc.includes("webSessions.delete(wt)"));
const fnBlock = serverSrc.slice(serverSrc.indexOf("function invalidateWebForUser"), serverSrc.indexOf("// Do not mark"));
s.check("the delete happens BEFORE the broadcast inside the invalidation (synchronous clear)", fnBlock.indexOf("webSessions.delete(wt)") < fnBlock.indexOf("broadcast(`web:${wt}`"));
s.check("the broadcast carries the reason field, not bare token invalidation", fnBlock.includes("{ type: \"webForceLoggedOut\", reason }"));
s.check("the trigger reason is the mobile new-phone flow's new_phone_login", serverSrc.includes('"new_phone_login"') && serverSrc.includes("mock/new-phone-login"));
s.check("no delayed/scheduled logout exists server-side", !/logout[\s\S]{0,260}setTimeout/.test(serverSrc));
s.check("mock/new-phone-login path calls the invalidation", /mock\/new-phone-login[\s\S]{0,220}invalidateWebForUser/.test(serverSrc));

s.section("client: a live session is shown a clean 'session ended, please rescan' state");
s.check("socket handler routes webForceLoggedOut to performSessionLogout(reason)", /webForceLoggedOut[\s\S]{0,120}performSessionLogout\(/.test(allClient));
s.check("performSessionLogout(reason) shows the reason notice first", /function performSessionLogout\(reason/.test(allClient) && /performSessionLogout\(reason[^)]*\): void \{[\s\S]*showForceLogoutNotice\(reason\)/.test(allClient));
s.check("the 401 validate fallback uses reason 'revoked'", allClient.includes('performSessionLogout("revoked")'));
s.check("the end-state notice copy names the cause", allClient.includes("A new phone signed in to this account") && allClient.replace(/\s+/g, " ").includes("Scan the QR below to reconnect"));
s.check("notice is shown ONLY on the gate and cleared on re-link", /if \(phase === "chat" && session\)/.test(allClient) && /handleLinked[\s\S]{0,120}showForceLogoutNotice\(null\)/.test(allClient));
s.check("manual logout clears the notice; force-logout sets it — mechanisms stay distinct", allClient.includes("showForceLogoutNotice(null)") && /showForceLogoutNotice\(reason\)/.test(allClient));
s.check("no grace-period / advance-warning copy exists", !/ends in |will be logged out in|logged out in|session ends in|expires in \d+ seconds/i.test(allClient));

s.section("dynamic: active Web sessions are force-logged-out the instant a new phone logs in");
const linkA = await http(PORT, "POST", "/api/mock/link-web", { userId: "mervin" });
const wtA = linkA.json?.webToken;
const wsA = wsClient(PORT, { webToken: wtA });
await wsA.ready;
s.check("session A is live and linked", linkA.ok && wsA.raw.readyState === 1);
await http(PORT, "POST", "/api/mock/new-phone-login", { userId: "mervin" });
const kickA = await wsA.waitEvent("webForceLoggedOut", { timeout: 3000 });
s.check("session A receives the real-time kick with reason new_phone_login", kickA.reason === "new_phone_login");
s.check("A's token is a hard 401 immediately after the kick (no grace window)", (await http(PORT, "GET", `/api/session/validate/${wtA}`)).status === 401);
const reg1 = await http(PORT, "GET", "/api/mock/web-sessions");
s.check("the registry no longer lists the kicked session", !reg1.json?.sessions.some((x) => x.userId === "mervin"));

s.section("dynamic: all concurrent sessions are cut off at once");
const linkB = await http(PORT, "POST", "/api/mock/link-web", { userId: "mervin" });
const wtB = linkB.json?.webToken;
const wsB = wsClient(PORT, { webToken: wtB });
await wsB.ready;
await http(PORT, "POST", "/api/mock/new-phone-login", { userId: "mervin" });
const kickB = await wsB.waitEvent("webForceLoggedOut", { timeout: 3000 });
s.check("session B is also kicked in real time", kickB.reason === "new_phone_login");
s.check("B's token is immediately invalid too", (await http(PORT, "GET", `/api/session/validate/${wtB}`)).status === 401);
const reg2 = await http(PORT, "GET", "/api/mock/web-sessions");
s.check("registry cleared for the user across the board", reg2.json?.sessions.every((x) => x.userId !== "mervin"));

s.section("dynamic: the flow is fully recoverable and independent");
const relink = await http(PORT, "POST", "/api/mock/link-web", { userId: "mervin" });
const wtC = relink.json?.webToken;
const wsC = wsClient(PORT, { webToken: wtC });
await wsC.ready;
s.check("a fresh link works after kicks", relink.ok && typeof wtC === "string");
s.check("the fresh session validates", (await http(PORT, "GET", `/api/session/validate/${wtC}`)).ok);
const reg3 = await http(PORT, "GET", "/api/mock/web-sessions");
s.check("exactly one fresh session exists after re-link", reg3.json?.sessions.filter((x) => x.userId === "mervin").length === 1);
await http(PORT, "POST", "/api/messages/send", { from: "pravan", type: "direct", to: "mervin", text: "relinked and fully functional" });
const live = await wsC.waitEvent("message", { timeout: 3000, predicate: (m) => m.text === "relinked and fully functional" });
s.check("the relinked session receives live traffic (end-to-end functional)", live.type === "message");
const phoneStatus = await http(PORT, "GET", "/api/mock/phone-status/mervin");
s.check("the demo-phone side is fully independent of the kick", phoneStatus.ok);

s.section("dynamic: repeat kicks stay well-behaved");
const t0 = Date.now();
await http(PORT, "POST", "/api/mock/new-phone-login", { userId: "mervin" });
const kickC = await wsC.waitEvent("webForceLoggedOut", { timeout: 3000 });
s.check("a second kick arrives while the socket is active", kickC.type === "webForceLoggedOut" && Date.now() - t0 < 3000);
s.check("second kick again leaves the token invalid + registry empty", (await http(PORT, "GET", `/api/session/validate/${wtC}`)).status === 401 && (await http(PORT, "GET", "/api/mock/web-sessions")).json?.sessions.filter((x) => x.userId === "mervin").length === 0);
const relink2 = await http(PORT, "POST", "/api/mock/link-web", { userId: "mervin" });
s.check("linking remains possible after many kicks", relink2.ok && typeof relink2.json?.webToken === "string");
s.check("the final relink's token validates and owns the account", (await http(PORT, "GET", `/api/session/validate/${relink2.json.webToken}`)).json?.userId === "mervin");

s.summary();
wsA.close();
wsB.close();
wsC.close();
stopServer(server);
process.exit(s.failed === 0 ? 0 : 1);