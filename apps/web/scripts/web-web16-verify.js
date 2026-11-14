// WEB tab-close persistence — closing the tab NEVER ends the session; manual
// Settings->Logout is the only real logout (and is clearly distinct from the
// automatic 401/new-phone cutoff). Session lives in localStorage, restored on
// boot with no QR. Static checks target the replacement client + server
// sources; dynamic checks run the close/open + explicit-logoff cycles.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Suite, http, startServer, stopServer } from "./_h.mjs";

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
const allClient = clientFiles.map((f) => fs.readFileSync(path.join(APP, f), "utf8")).join("\n");
const serverSrc = fs.readFileSync(path.join(APP, "server/wpt-server.mjs"), "utf8");

const PORT = 3926;
const server = startServer(PORT);
await server.ready;
const s = new Suite("WEB tab-close verify (31)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

s.section("storage: session is persisted, never in-memory/sessionStorage");
s.check("session persisted under wpt_web_session_v1", allClient.includes("wpt_web_session_v1"));
s.check("storage API is localStorage", allClient.includes("localStorage"));
s.check("sessionStorage is never used anywhere", !/window\.sessionStorage|(?:^|[^\w'"`])sessionStorage\s*\./.test(allClient));
s.check("session save includes webToken + userId", allClient.includes("webToken") && allClient.includes("userId"));
s.check("chat state is persisted under wpt_web_app_state_v1 with history", allClient.includes("wpt_web_app_state_v1") && allClient.includes("chatHistory"));

s.section("closing the tab runs no cleanup");
s.check("no beforeunload handler", !/addEventListener\(\s*['"]beforeunload['"]|onbeforeunload\s*=/.test(allClient));
s.check("no pagehide handler", !/addEventListener\(\s*['"]pagehide['"]|onpagehide\s*=/.test(allClient));
s.check("no unload/onunload handler", !/['"]unload['"]|onunload/.test(allClient));
s.check("visibilitychange returns while document is hidden", allClient.includes("if (document.hidden) return"));

s.section("manual logoff (WEB-R1.6) is a distinct mechanism from tab close");
s.check("clearWebSession() has exactly 2 call sites (both logout paths)", (allClient.match(/clearWebSession\(\);/g) || []).length === 2);
s.check("manual logout revokes server-side via POST /api/session/logout", allClient.includes('"/api/session/logout"'));
s.check("manual logout clears the notice (fresh QR, no force-logout banner)", allClient.includes("showForceLogoutNotice(null)"));
s.check("both logout paths reset to the QR gate via resetToGate()", /function performSessionLogout[\s\S]{0,240}clearWebSession\(\)[\s\S]{0,240}resetToGate\(\)/.test(allClient) && /async function manualLogout[\s\S]{0,500}resetToGate\(\)/.test(allClient));
s.check("force-logout notice only ever shows the ended-session reason", allClient.includes("showForceLogoutNotice(") && /performSessionLogout\(reason[^)]*\): void \{[\s\S]*showForceLogoutNotice\(reason\)/.test(allClient));

s.section("boot restore needs no QR");
s.check("boot decides the phase from the backend-validated HttpOnly session, not localStorage", /\bbffApi<[\s\S]{0,240}>\(["']GET["'],\s*["']\/api\/session\/status["']\)[\s\S]{0,1800}setPhase\("chat"\)/.test(allClient));
s.check("an existing session means the QR gate is never rendered", allClient.includes("if (phase === \"chat\" && session)"));
s.check("boot restores the persisted chat state", allClient.includes("restoreAppState()"));
s.check("boot restores the persisted outbox", allClient.includes("createLocalOutbox()") || allClient.includes("outboxRef"));

s.section("server never expires idle/closed-tab sessions");
s.check("the server registry is only cleared by invalidation or explicit logout (2 delete sites)", (serverSrc.match(/webSessions\.delete\(wt\)/g) || []).length === 2);
s.check("validate has no TTL/expiry logic", !/session\/validate[\s\S]{0,400}expiresAt/.test(serverSrc));

s.section("dynamic: close the tab, reopen the URL");
const link = await http(PORT, "POST", "/api/mock/link-web", { userId: "mervin" });
const wt = link.json?.webToken;
s.check("session linked", link.ok && typeof wt === "string");
s.check("session valid while the tab is open", (await http(PORT, "GET", `/api/session/validate/${wt}`)).ok);
await sleep(600);
s.check("session valid after an idle interval (simulated closed tab)", (await http(PORT, "GET", `/api/session/validate/${wt}`)).ok);
const reg = await http(PORT, "GET", "/api/mock/web-sessions");
s.check("server registry still lists the session — no close/TTL eviction", reg.json?.sessions.some((x) => x.userId === "mervin"));
await http(PORT, "POST", "/api/messages/send", { from: "mervin", type: "direct", to: "pravan", text: "reopen keeps my data" });
const recent = await http(PORT, "GET", "/api/recent-chats/mervin");
s.check("reopening restores chat data via the persisted session (recent-chats has it)", recent.json?.items.some((i) => i.preview === "reopen keeps my data"));

s.section("dynamic: explicit logoff still ends it (different from tab close)");
const logout = await http(PORT, "POST", "/api/session/logout", { webToken: wt });
s.check("explicit logout returns ok", logout.ok);
const regAfter = await http(PORT, "GET", "/api/mock/web-sessions");
s.check("logout removed the session from the server registry", !regAfter.json?.sessions.some((x) => x.userId === "mervin"));
s.check("validating a logged-out token is a hard 401", (await http(PORT, "GET", `/api/session/validate/${wt}`)).status === 401);
const relink = await http(PORT, "POST", "/api/mock/link-web", { userId: "mervin" });
s.check("a fresh link works after explicit logoff", relink.ok && typeof relink.json?.webToken === "string");
s.check("fresh token validates", (await http(PORT, "GET", `/api/session/validate/${relink.json.webToken}`)).ok);

s.section("edge case documented");
const readme = fs.existsSync(path.join(APP, "README.md")) ? fs.readFileSync(path.join(APP, "README.md"), "utf8") : "";
s.check("README documents storage + incognito caveat", readme.includes("incognito") && readme.includes("wpt_web_session_v1"));

s.summary();
stopServer(server);
process.exit(s.failed === 0 ? 0 : 1);