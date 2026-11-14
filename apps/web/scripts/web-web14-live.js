// WEB-R1.4 LIVE — real WebSocket wire test for the replacement: the Web socket
// keeps delivering live inbound while the demo phone is offline, reconnects
// after its own blip, and only revocation (401 + webForceLoggedOut) ends it.
import { Suite, http, startServer, stopServer, wsClient } from "./_h.mjs";

const PORT = 3924;
const server = startServer(PORT);
await server.ready;
const s = new Suite("WEB-R1.4 live socket (22)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

s.section("1) Web socket connects (session-linked)");
s.check("health is up on the live port", (await http(PORT, "GET", "/api/health")).ok);
const link = await http(PORT, "POST", "/api/mock/link-web", { userId: "mervin" });
const wt = link.json?.webToken;
s.check("a session is minted headlessly", link.ok && typeof wt === "string");
const ws1 = wsClient(PORT, { webToken: wt });
await ws1.ready;
s.check("socket opens with the session webToken", ws1.raw.readyState === 1);

s.section("2) phone Wi-Fi/data OFF");
await http(PORT, "POST", "/api/mock/phone-offline", { userId: "mervin" });
const off = await http(PORT, "GET", "/api/mock/phone-status/mervin");
s.check("phone offline is reported", off.json?.online === false);
s.check("Web socket stays connected while the phone is down", ws1.raw.readyState === 1);

s.section("3) Web stays interactive: live inbound arrives DURING phone-offline");
const queued = await http(PORT, "POST", "/api/mock/phone-message", { userId: "mervin", text: "queued while offline" });
s.check("message created while phone offline is queued, not delivered", queued.json?.queued !== false && queued.ok);
let premature = false;
try {
  await ws1.waitEvent("mockIncomingMessage", { timeout: 600 });
  premature = true;
} catch {
  premature = false;
}
s.check("nothing is pushed over the socket while the phone is offline", premature === false);

const relayOffline = await http(PORT, "POST", "/api/messages/send", { from: "pravan", type: "direct", to: "mervin", text: "another device reached me while the phone was off" });
s.check("anoter-device relay send is accepted during phone-offline", relayOffline.ok);
const live = await ws1.waitEvent("message", { timeout: 3000, predicate: (m) => m.text?.includes("another device") });
s.check("that relayed inbound arrives live on the socket DURING phone-offline", live.type === "message");

s.section("4) phone returns: Web unaffected, queued flow flushes");
const backOnline = await http(PORT, "POST", "/api/mock/phone-online", { userId: "mervin" });
s.check("phone comes back online with the queued capture count", backOnline.json?.online === true && backOnline.json?.synced === 1);
const statusEv = await ws1.waitEvent("mockPhoneStatus", { timeout: 3000 });
s.check("socket hears the online transition", statusEv.type === "mockPhoneStatus");
const catchUp = await ws1.waitEvent("mockIncomingMessage", { timeout: 3000, predicate: (m) => m.text === "queued while offline" });
s.check("queued message is flushed to the Web silently on reconnect", catchUp.type === "mockIncomingMessage");

s.section("5) repeated cycles are invisible to the session");
await http(PORT, "POST", "/api/mock/phone-offline", { userId: "mervin" });
s.check("a second offline cycle starts", (await http(PORT, "GET", "/api/mock/phone-status/mervin")).json?.online === false);
s.check("session valid mid-cycle", (await http(PORT, "GET", `/api/session/validate/${wt}`)).ok);
await http(PORT, "POST", "/api/mock/phone-online", { userId: "mervin" });
s.check("second cycle recovers", (await http(PORT, "GET", "/api/mock/phone-status/mervin")).json?.online === true);

s.section("6) socket loss is NOT fatal: reconnect rejoins and refreshes");
ws1.close();
await sleep(150);
const ws2 = wsClient(PORT, { webToken: wt });
await ws2.ready;
s.check("a fresh socket on the same webToken reconnects cleanly", ws2.raw.readyState === 1);
const recent = await http(PORT, "GET", "/api/recent-chats/mervin");
s.check("state refreshes after reconnect (recent-chats has the live content)", recent.json?.items.some((i) => i.preview?.includes("another device")));
const afterReconnect = await http(PORT, "POST", "/api/messages/send", { from: "pravan", type: "direct", to: "mervin", text: "still live after reconnect" });
s.check("a new relayed send after reconnect is accepted", afterReconnect.ok);
const relive = await ws2.waitEvent("message", { timeout: 3000, predicate: (m) => m.text === "still live after reconnect" });
s.check("reconnected socket re-joins the user room and receives live traffic", relive.type === "message");

s.section("7) only a revoked session ends the Web session");
let kicked = false;
try {
  await ws2.waitEvent("webForceLoggedOut", { timeout: 600 });
  kicked = true;
} catch {
  kicked = false;
}
s.check("no premature force-logout while the session is valid", kicked === false);
await http(PORT, "POST", "/api/mock/new-phone-login", { userId: "mervin" });
const kick = await ws2.waitEvent("webForceLoggedOut", { timeout: 3000 });
s.check("new-phone login force-logs the live Web socket with a reason", kick.reason === "new_phone_login");
const afterKick = await http(PORT, "GET", `/api/session/validate/${wt}`);
s.check("the token is a hard 401 immediately (no grace window)", afterKick.status === 401);

if (s.summary()) {
  ws2.close();
  stopServer(server);
  process.exit(0);
}
ws2.close();
stopServer(server);
process.exit(1);