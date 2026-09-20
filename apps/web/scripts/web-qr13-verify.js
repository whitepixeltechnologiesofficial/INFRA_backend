// QR-1.3 / QR-1.4 verification against the replacement web server.
import { Suite, http, startServer, stopServer, wsClient } from "./_h.mjs";

const PORT = 3920;
const server = startServer(PORT, { qrTtlMs: 60000 });
await server.ready;
const s = new Suite("WEB QR-1.3/1.4 verify (20)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

s.section("baseline endpoints");
const health = await http(PORT, "GET", "/api/health");
s.check("health reports users+groups+websocket", health.ok && health.json?.users === 16 && health.json?.groups >= 1 && health.json?.websocket === true);

const users = await http(PORT, "GET", "/api/users");
s.check("users list has 16 team members", users.ok && Array.isArray(users.json) && users.json.length === 16);
s.check("mervin is owner", users.ok && users.json.some((u) => u.id === "mervin" && u.role === "owner"));

s.section("fresh mint");
const mint1 = await http(PORT, "GET", "/api/link/new");
s.check("mint returns a fresh token + expiresAt", mint1.ok && typeof mint1.json?.token === "string" && mint1.json.expiresAt > Date.now());
s.check("mint embeds a data-url PNG QR", mint1.ok && typeof mint1.json?.qrDataUrl === "string" && mint1.json.qrDataUrl.startsWith("data:image/png;base64,"));
s.check("minted link points at the phone/link page with that token", mint1.ok && mint1.json.linkUrl.endsWith(`/phone/link/${mint1.json.token}`) && mint1.json.linkUrl.includes("/phone/link/"));
s.check("phone/link page is served for a valid token", (await http(PORT, "GET", `/phone/link/${mint1.json.token}`)).status === 200);
s.check("scan (GET link/:token) reveals the account", (await http(PORT, "GET", `/api/link/${mint1.json.token}`)).json?.accountName === "Mervin Roger");

s.section("expiry + regeneration never reuse a token");
const ttl = 400;
const srv2 = startServer(3921, { qrTtlMs: ttl });
await srv2.ready;
const m1 = await http(3921, "GET", "/api/link/new");
const m2 = await http(3921, "GET", "/api/link/new");
s.check("regen mints a distinct token", m2.ok && m1.json.token !== m2.json.token);
const oldScan = await http(3921, "GET", `/api/link/${m1.json.token}`);
s.check("replaced token is refused (410 already_used / expired)", oldScan.status === 410);

await sleep(ttl + 250);
const expiredScan = await http(3921, "GET", `/api/link/${m2.json.token}`);
s.check("expired token is refused after TTL", expiredScan.status === 410);
stopServer(srv2);

s.section("confirm + real-time accountLinked");
const ws = wsClient(PORT, { qrSession: mint1.json.token });
await ws.ready;
const confirm = await http(PORT, "POST", `/api/link/${mint1.json.token}/confirm`, { authenticated: true });
s.check("confirm starts linking state, not an immediate session", confirm.ok && confirm.json?.state === "linking");

const linked = await ws.waitEvent("accountLinked", { timeout: 4000, predicate: (m) => m.type === "accountLinked" && m.webToken && m.userId });
s.check("qrSession socket receives accountLinked with webToken+userId", linked.webToken && linked.userId === "mervin");
s.check("accountLinked webToken is a fresh 48-hex session token", /^[0-9a-f]{48}$/.test(linked.webToken));

const validate = await http(PORT, "GET", `/api/session/validate/${linked.webToken}`);
s.check("the new webToken validates with the account id", validate.ok && validate.json?.userId === "mervin");

s.section("post-link hardening");
const usedScan = await http(PORT, "GET", `/api/link/${mint1.json.token}`);
s.check("linked token can no longer be scanned", usedScan.status === 410);
const usedConfirm = await http(PORT, "POST", `/api/link/${mint1.json.token}/confirm`, {});
s.check("linked token cannot be confirmed twice", usedConfirm.status === 410);

const qrState = await http(PORT, "GET", "/api/mock/qr-sessions");
s.check("qr-sessions debug lists the linked session (status linked)", qrState.ok && qrState.json.sessions.some((x) => x.token === mint1.json.token && x.status === "linked" && x.linked));

s.section("linking-window guard (TTL shorter than confirm delay)");
const srv3 = startServer(3922, { qrTtlMs: 120 });
await srv3.ready;
const g1 = await http(3922, "GET", "/api/link/new");
const ws2 = wsClient(3922, { qrSession: g1.json.token });
await ws2.ready;
await http(3922, "POST", `/api/link/${g1.json.token}/confirm`, {});
await sleep(ttl <= 120 ? ttl + 700 : 700); // wait well past the 120ms TTL and the 650ms confirm callback
let windowSession = false;
try {
  const ev = await ws2.waitEvent("accountLinked", { timeout: 1500 });
  windowSession = !!ev.webToken;
} catch {
  windowSession = false;
}
s.check("confirm that outlives the TTL never creates a session (linking-window guard)", windowSession === false);
const g1Validate = await http(3922, "GET", `/api/session/validate/${requireFirst(ws2)}`);
s.check("no webToken was minted on the guarded confirm", g1Validate.status === 401);
stopServer(srv3 || server);
ws.close();

if (s.summary()) {
  stopServer(server);
  process.exit(0);
}
stopServer(server);
process.exit(1);

function requireFirst(wsx) {
  const ev = wsx.events.find((e) => e.type === "accountLinked");
  return ev?.webToken || "000000000000000000000000000000000000000000000000";
}