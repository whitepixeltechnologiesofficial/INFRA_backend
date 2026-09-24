// WEB 2.1 — Sealine Phase-5 design restyle verification.
// Static checks assert the Phase-5 UI contract across the sources:
//   theme system (data-theme + persisted wpt_web_theme_v1 + fonts),
//   QR gate (countdown ring --pct, expired overlay, required notice copy kept),
//   linking screen, chat surface (sidebar/thread/search/status ticks/panels),
//   and that the restyle left the invisible-reconnect + session-hygiene
//   invariants intact. Dynamic checks cover the two data sources the new
//   panels depend on (/api/groups contract + a live link/validate cycle).
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Suite, http, startServer, stopServer } from "./_h.mjs";

const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (f) => fs.readFileSync(path.join(APP, f), "utf8");
const css = read("app/globals.css");
const layout = read("app/layout.tsx");
const theme = read("app/lib/theme.ts");
const qrGate = read("app/wpt/qr-gate.tsx");
const linking = read("app/wpt/linking-screen.tsx");
const webApp = read("app/wpt/web-app.tsx");
const chatApp = read("app/wpt/chat-app.tsx");
const types = read("app/wpt/types.ts");

const allClient = [layout, theme, qrGate, linking, webApp, chatApp, read("app/lib/app-state.ts"), read("app/lib/ws.ts")].join("\n");

const PORT = 3929;
const server = startServer(PORT);
await server.ready;
const s = new Suite("WEB 2.1 Phase-5 design (WEB 2.1)");

s.section("design system");
s.check("body carries data-theme (theme module applies it) and both palettes exist", theme.includes('setAttribute("data-theme"') && css.includes('body[data-theme="light"]') && css.includes("--bg: #0b0f14"));
s.check("dark is the canonical palette with overrides for light", /body\[data-theme="light"\]/.test(css) && css.includes("--bubble-own"));
s.check("Space Grotesk / Inter / IBM Plex Mono are wired", layout.includes("Space+Grotesk") && layout.includes("Inter") && layout.includes("IBM+Plex+Mono") && /--font-display: ["']Space Grotesk/.test(css) && /--font-mono: ["']IBM Plex Mono/.test(css));
s.check("teal brand palette is present", css.includes("#0f9c90") && css.includes("#14b3a6"));
s.check("theme is persisted under wpt_web_theme_v1 and supports system", theme.includes("wpt_web_theme_v1") && theme.includes('"system"') && theme.includes("prefers-color-scheme"));

s.section("QR gate");
s.check("countdown ring drives --pct and wraps the code", /\.qr-ring[\s\S]*conic-gradient[\s\S]*var\(--pct/.test(css) && qrGate.includes('"--pct"'));
s.check("expired overlay renders 'Code expired' + regeneration copy", qrGate.includes("Code expired") && qrGate.includes("Generating a new one…"));
s.check("required force-logout notice copy kept verbatim", qrGate.includes("A new phone signed in to this account") && qrGate.includes("closed immediately") && qrGate.replace(/\s+/g, " ").includes("Scan the QR below to reconnect"));
s.check("gate shows a manual-logoff flash pill (toast)", qrGate.includes('className={`toast') && qrGate.includes("onFlashClear"));
s.check("linking steps + web-only-works-with-phone note present", qrGate.includes("qr-steps") && /Web only works alongside the phone app/.test(qrGate));

s.section("linking screen");
s.check("linking screen exists with encryption-rekey copy", linking.includes("Linking your device…") && linking.includes("fresh encryption identity"));

s.section("chat surface");
s.check("sidebar with brand + new-chat/settings actions", chatApp.includes("New chat") && chatApp.includes("Settings") && chatApp.includes("sb-search"));
s.check("unread badges, presence dot, watermark time in rows", chatApp.includes("ch-badge") && chatApp.includes("ch-avatar-wrap") && chatApp.includes("ch-time"));
s.check("empty chat list CTA exists", chatApp.includes("No chats yet"));
s.check("reconnecting banner maps to the socket state", webApp.includes("socketOk") && chatApp.includes("Reconnecting…"));
s.check("message bubbles carry sender labels + sent/delivered/read/failed status ticks", chatApp.includes("b-name") && chatApp.includes("StatusTick") && chatApp.includes("Failed to send") && chatApp.includes('"read"'));
s.check("date dividers group the day", chatApp.includes("day-divider") && chatApp.includes("dayLabel"));
s.check("in-chat search with highlight, count and prev/next nav", chatApp.includes("in-search") && /mark[^>]*className=["']hl/.test(chatApp) && chatApp.includes(" of ") && chatApp.includes("stepSearch"));
s.check("composer has attach/voice/send with stamp", chatApp.includes("cm-btn") && chatApp.includes("🎤") && chatApp.includes("stamp"));
s.check("new-chat panel shows synced-only list vs no-match and no Contacts request", chatApp.includes("Synced contacts") && chatApp.includes("not-on") && chatApp.includes("request its own Contacts permission"));
s.check("group-info panel uses the /api/groups contract", chatApp.includes("GroupInfoPanel") && chatApp.includes("membersCanMessage") && types.includes("ServerGroup"));
s.check("settings panel has theme, device, blocked + log-off", chatApp.includes("Theme") && chatApp.includes("This device") && chatApp.includes("Blocked contacts") && chatApp.includes("Log off this device"));
s.check("blocked-contacts panel is present", chatApp.includes("BlockedPanel") && chatApp.includes("No blocked contacts on this device"));
s.check("log-off confirm modal precedes logout (manual-logout stays explicit)", chatApp.includes("Log off this device?") && chatApp.includes("onLogout"));

s.section("hygiene survived the restyle");
s.check("no sync-unit tokens leaked into chat/web-app/ws", !allClient.includes("syncing") && !allClient.includes("Syncing") && !allClient.includes("Sending…") && !/(?:^|[^\w'"`])syncing\b/i.test(allClient));
s.check("no loading/spinner/toast/snackbar tokens in the session-path files", !/loading\b|spinner|toast|snackbar/i.test([chatApp, webApp, read("app/lib/ws.ts")].join("\n")));
s.check("clearWebSession still has exactly 2 call sites", (webApp.match(/clearWebSession\(\);/g) || []).length === 2);
s.check("manual logout still revokes via /api/session/logout and the rescan notice clears on re-link", /handleLinked[\s\S]{0,140}showForceLogoutNotice\(null\)/.test(webApp));
s.check("brand moved to Sealine everywhere it is rendered", (/Sealine/.test(chatApp) && /Sealine Web/.test(qrGate) && layout.includes("Sealine Web")));

s.section("dynamic: new-panel data sources are live");
const groups = await http(PORT, "GET", "/api/groups");
s.check("/api/groups returns groups with members + settings (Group Info contract)", groups.ok && Array.isArray(groups.json) && groups.json.some((g) => g.id === "project" && Array.isArray(g.members) && typeof g.settings?.membersCanMessage === "boolean" && g.members.some((m) => m.role === "owner")));
const users = await http(PORT, "GET", "/api/users");
s.check("/api/users feeds the New Chat picker", users.ok && Array.isArray(users.json) && users.json.length >= 6);
const link = await http(PORT, "POST", "/api/mock/link-web", { userId: "mervin" });
const wt = link.json?.webToken;
s.check("a session can be linked for the restyled UI", link.ok && typeof wt === "string");
s.check("the linked session validates (gate→chat handoff data is intact)", (await http(PORT, "GET", `/api/session/validate/${wt}`)).ok);

s.summary();
stopServer(server);
process.exit(s.failed === 0 ? 0 : 1);