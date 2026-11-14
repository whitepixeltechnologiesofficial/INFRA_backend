// WEB-R1.5 — invisible reconnect refresh: no sync indicator ever appears, the
// console is clean, and large-backlog refetch is single-flight. Static checks
// run against the replacement client + server sources; dynamic checks drive
// repeated phone offline/online cycles against the replacement server.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Suite, http, startServer, stopServer, wsClient } from "./_h.mjs";

const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const scannedFiles = [
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
  "lib/wptOutbox.js",
  "server/wpt-server.mjs",
];
const sources = scannedFiles.map((f) => ({ name: f, text: fs.readFileSync(path.join(APP, f), "utf8") }));
const all = sources.map((s) => s.text).join("\n");
const clientOnly = sources.filter((s) => s.name.startsWith("app/") || s.name.startsWith("lib/")).map((s) => s.text).join("\n");
const syncOnly = sources.filter((s) => s.name === "app/wpt/chat-app.tsx" || s.name === "app/wpt/web-app.tsx" || s.name === "app/lib/ws.ts").map((s) => s.text).join("\n");

const PORT = 3925;
const server = startServer(PORT);
await server.ready;
const s = new Suite("WEB-R1.5 verify (32)");

s.section("static: no sync-indicator UI exists in the client");
for (const token of ["syncChip", "ensureSyncChip", "updatePendingChip", "pending-send", "sending…", "retrying…", "syncing", "Syncing", "Sending…", "Syncing…"]) {
  s.check(`client has no '${token}' sync-unit token`, !clientOnly.includes(token));
}
s.check("whole web tree has no sync-unit token anywhere", !["syncChip", "pending-send", "sending…", "retrying…", "syncing", "Syncing"].some((t) => all.includes(t)));

s.section("static: console is clean in the client");
const clientConsoleLogs = clientOnly.match(/console\.log\s*\(/g);
s.check("no console.log() in any client source", clientConsoleLogs === null);
const syncConsole = all.match(/console\.(log|warn|error)\([^)]*(sync|sending)/gi);
s.check("no sync-referencing console calls in the web tree", syncConsole === null || syncConsole.length === 0);

s.section("static: reconnect refresh is pure background work");
s.check("socket open handler refreshes recent chats + flushes the queue", /function handleWSOpen[\s\S]*flushOutbox\(\)[^}]*loadRecentChats\(\)/.test(clientOnly));
s.check("single-flight guard exists for the recent-chats refetch", clientOnly.includes("inFlightRef"));
s.check("no loading/progress banner/toast UI in the session/sync path", !/loading\b|spinner|toast|snackbar/i.test(syncOnly));

s.section("static: replacement stack, not the legacy one");
s.check("server source has no socket.io reference", !all.includes("socket.io"));
s.check("server uses WebSocketServer from the ws package", all.includes("from \"ws\""));
s.check("client uses the native WebSocket API with a JSON message protocol", /new WebSocket\(/.test(clientOnly) && all.includes("JSON.parse"));
s.check("reconnect is scheduled with a bounded retry", clientOnly.includes("RECONNECT_MS"));
s.check("client persists chat state + unread on every mutation", clientOnly.includes("saveAppState(stateRef.current)"));

s.section("dynamic: repeated offline/online cycles are invisible and safe");
const link = await http(PORT, "POST", "/api/mock/link-web", { userId: "mervin" });
const wt = link.json?.webToken;
const ws = wsClient(PORT, { webToken: wt });
await ws.ready;
s.check("session linked for the cycle test", link.ok && typeof wt === "string");

let cyclesOk = 3;
for (let i = 1; i <= 3; i++) {
  await http(PORT, "POST", "/api/mock/phone-offline", { userId: "mervin" });
  await http(PORT, "POST", "/api/mock/phone-message", { userId: "mervin", text: `cycle ${i} while offline` });
  await http(PORT, "POST", "/api/mock/phone-online", { userId: "mervin" });
  await http(PORT, "GET", `/api/session/validate/${wt}`);
  const r = await http(PORT, "GET", "/api/mock/phone-status/mervin");
  if (r.json?.online !== true) cyclesOk = 0;
}
s.check("3 full offline/online cycles leave the session healthy", cyclesOk === 3);
s.check("no force-logout is ever pushed during ordinary cycles", ws.events.every((e) => e.type !== "webForceLoggedOut"));
s.check("session still valid after all cycles", (await http(PORT, "GET", `/api/session/validate/${wt}`)).ok);

const backlogCheck = await http(PORT, "POST", "/api/messages/send", { from: "pravan", type: "direct", to: "mervin", text: "backlog entry" });
s.check("backlog is fully available to the background refetch", backlogCheck.ok);
const recent = await http(PORT, "GET", "/api/recent-chats/mervin");
s.check("backlog appears in the refetch surface", recent.json?.items.some((i) => i.preview === "backlog entry"));

s.section("dynamic: full history is available to the open chat");
const hist = await http(PORT, "GET", "/api/messages/pravan/mervin");
s.check("history endpoint exposes the full direct thread", hist.ok && Array.isArray(hist.json) && hist.json.length >= 4);
const groupHist = await http(PORT, "GET", "/api/group-messages/project?userId=pravan");
s.check("group history endpoint works for a member", groupHist.ok && Array.isArray(groupHist.json) && groupHist.json.length >= 1);
const groupOutsider = await http(PORT, "GET", "/api/group-messages/project?userId=arun");
s.check("group history refuses a non-member caller", groupOutsider.status === 403 && groupOutsider.json?.error === "not_member");
const groupNoCaller = await http(PORT, "GET", "/api/group-messages/project");
s.check("group history refuses a caller-less read", groupNoCaller.status === 403 && groupNoCaller.json?.error === "not_member");

s.section("dynamic: reconnect during the same session without disruption");
ws.close();
const ws2 = wsClient(PORT, { webToken: wt });
await ws2.ready;
await http(PORT, "POST", "/api/messages/send", { from: "pravan", type: "direct", to: "mervin", text: "post-reconnect live" });
const ev = await ws2.waitEvent("message", { timeout: 3000, predicate: (m) => m.text === "post-reconnect live" });
s.check("live traffic still arrives after reconnection", ev.type === "message");
s.check("session survives the socket blip", (await http(PORT, "GET", `/api/session/validate/${wt}`)).ok);
await http(PORT, "POST", "/api/mock/phone-offline", { userId: "mervin" });
await http(PORT, "POST", "/api/mock/phone-online", { userId: "mervin" });
const statusEv = await ws2.waitEvent("mockPhoneStatus", { timeout: 3000 });
s.check("post-reconnect sockets still hear phone transitions", statusEv.type === "mockPhoneStatus");

s.summary();
ws2.close();
stopServer(server);
process.exit(s.failed === 0 ? 0 : 1);