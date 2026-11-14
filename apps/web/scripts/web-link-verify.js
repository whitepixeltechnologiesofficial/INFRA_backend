// WEB linking protocol verification — the WEB half of "scan to link".
//
// WHERE THE AUTHORITY LIVES NOW
//   The link protocol has exactly ONE implementation: apps/backend (token
//   admission, approval, the Socket.IO link push, the single-use code, the
//   one-browser session). apps/backend/src/web-link/web-link-verify.ts proves
//   that end to end against the real store/router/socket registry.
//   The chat mock in server/wpt-server.mjs no longer mints, scans, confirms or
//   pushes link codes — it is chat-only.
//
//   So this suite verifies what is left to verify on the Web side, and it does
//   it against the shipped code, not a copy of it:
//     · the browser's own token generator, executed for real (2000 draws) with
//       Math.random disabled, and pinned to crypto.getRandomValues;
//     · the public identity contract, checked on the real crypto primitive;
//     · registration-before-QR, no polling, cookie-only redemption, the retired
//       routes, and the single backend switch, read from the sources the app
//       ships (the same technique web-21…web-25 use for wiring contracts).
//
//   Run:  node scripts/web-link-verify.js
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Suite } from "./_h.mjs";
import {
  WEB_LINK_API,
  WEB_LINK_EVENTS,
  WEB_LINK_QR_PREFIX,
  WEB_LINK_TTL_MS,
  isWebLinkToken,
  parseWebLinkQrPayload,
  webLinkQrPayload,
} from "../../../packages/shared/src/web-link.ts";
import { generateWebLinkToken, WEB_LINK_TOKEN_HEX_LENGTH } from "../app/lib/web-link-token.ts";
// NOTE: @wpt/crypto / @wpt/api-client / @wpt/shared package entries are
// TS-source-only with Node-ESM ".js" specifiers, so bare Node can't load them
// (apps/web/next.config.mjs aliases those for webpack; tsx does it for the
// mobile/backend harnesses). The identity primitive itself is therefore pinned
// by source here — it is executed for real by the backend and mobile harnesses —
// while the Web half (the token) is executed for real right above.

const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(APP, rel), "utf8");
// Comments explain the invariants and deliberately NAME the forbidden things
// ("never Math.random", "the qrSession handshake was removed"), so every
// source assertion below runs against comment-stripped code.
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const s = new Suite("WEB link protocol verify (browser half)");

// ── 1. the browser owns the token's randomness ────────────────────────────────
s.section("1. browser-generated token (CSPRNG only, executed for real)");
// The real shipped function is called 2000 times with Math.random booby-trapped:
// any fallback to Math.random throws instead of silently weakening the token.
const realRandom = Math.random;
let drew = 0;
Math.random = () => {
  throw new Error("Math.random is not an allowed entropy source for a link token");
};
const tokens = [];
let mathRandomUsed = false;
try {
  for (let i = 0; i < 2000; i += 1) {
    tokens.push(generateWebLinkToken());
    drew += 1;
  }
} catch {
  mathRandomUsed = true;
} finally {
  Math.random = realRandom;
}
s.check(`2000 tokens generated (${drew}) with Math.random disabled`, drew === 2000 && !mathRandomUsed);
s.check("every token is 64 lowercase hex chars", tokens.every((t) => /^[0-9a-f]{64}$/.test(t)));
s.check("the shared token predicate accepts every one of them", tokens.every(isWebLinkToken));
s.check("2000 draws are all distinct (no counter, seed or clock reuse)", new Set(tokens).size === 2000);
s.check("tokens carry nothing but hex (no phone/user/host/timestamp material)", tokens.every((t) => !/[A-Z+@.:]/.test(t)));
s.check("the exported length constant matches 32 bytes", WEB_LINK_TOKEN_HEX_LENGTH === 64);
const tokenSrc = code("app/lib/web-link-token.ts");
s.check("the generator reads exactly 32 bytes from crypto.getRandomValues", /const TOKEN_BYTES = 32/.test(tokenSrc) && /new Uint8Array\(TOKEN_BYTES\)/.test(tokenSrc) && /crypto\.getRandomValues\(bytes\)/.test(tokenSrc));
s.check("the generator module imports nothing (no reachable entropy/clock helper)", !/^\s*import\s/m.test(tokenSrc));
s.check("the generator never touches Date/Math/uuid/randomUUID", !/Date|Math\.|uuid|randomUUID/.test(tokenSrc));
s.check("there is no second token generator in the Web app", read("app/lib/web-link-client.ts").includes('from "./web-link-token"'));

// ── 2. the identity is public-only ────────────────────────────────────────────
s.section("2. public identity bundle (private key never leaves memory)");
const primitives = read("../../packages/crypto/src/primitives.ts");
s.check("the crypto primitive is an ed25519 keypair generator", /ed25519/i.test(primitives) && /privateKey/.test(primitives) && /publicKey/.test(primitives));
s.check("generateIdentityKeyPair is exported (the Web's identity source)", /export function generateIdentityKeyPair|export const generateIdentityKeyPair/.test(primitives));
const client = code("app/lib/web-link-client.ts");
s.check("the bundle is built from the ed25519 public key only", /generateIdentityKeyPair\(\)/.test(client) && /publicKey: toBase64Url\(pair\.publicKey\)/.test(client));
s.check("the bundle has no private/secret key field", !/privateKey:\s*|secretKey:\s*/.test(client));
s.check("the private key is retained in a module variable for this page's E2EE", /heldPrivateKey\s*=\s*pair\.privateKey/.test(client) && /webIdentityPrivateKey/.test(client));
s.check("nothing serializes the private key (no JSON/base64/QR/storage of it)", !/JSON\.stringify\((heldPrivateKey|pair\.privateKey)|toBase64Url\(pair\.privateKey|btoa\((heldPrivateKey|pair\.privateKey)|localStorage|sessionStorage|indexedDB/.test(client));
s.check("the public key is encoded base64url (URL/QR safe)", /btoa\(binary\)[\s\S]{0,80}replace\(\/\\\+\/g, "-"\)/.test(client));
s.check("the register payload carries identity, not a keypair", /body: JSON\.stringify\(\{ token, identity \}\)/.test(client));
s.check("no private key can appear in the register body", !/JSON\.stringify\([^\n]*privateKey/.test(client));

// ── 3. registration is the gate before any QR exists ──────────────────────────
s.section("3. registration before QR");
s.check("register POSTs token+identity to the BFF register route", /fetch\("\/api\/link\/register"/.test(client) && /JSON\.stringify\(\{ token, identity \}\)/.test(client));
s.check("register generates the token itself (no token in the response path)", /const token = generateWebLinkToken\(\)/.test(client));
s.check("register uses the LOCAL token, never a server-minted one", /token,\n/.test(client) && /\btoken: token\b|return \{\n    ok: true,\n    token,/.test(client));
s.check("register fails closed when the body is unusable", /!isWebLinkToken\(token\) \|\| !Number\.isFinite\(expiresAt\) \|\| typeof body\.linkTicket !== "string"/.test(client));
s.check("register maps a rejection to a failure variant, never a QR", /body\.ok !== true/.test(client) && /register_failed/.test(client));
s.check("register maps a dead network to a retry message", /error: "unreachable"/.test(client));
s.check("register returns the link ticket + backend origin the channel needs", /linkTicket: body\.linkTicket/.test(client) && /realtimeBaseUrl/.test(client));
const registerRoute = read("app/api/link/register/route.ts");
s.check("the BFF register route mints no token of its own", !/randomBytes|getRandomValues|Math\.random|randomUUID/.test(registerRoute));
s.check("the BFF register route forwards the browser's token + identity", /token/.test(registerRoute) && /identity/.test(registerRoute));
s.check("the BFF hands the single-scope link ticket back to the page", /linkTicket/.test(registerRoute));
s.check("the BFF hands the backend realtime origin back to the page", /realtimeBaseUrl/.test(registerRoute));

// ── 4. the pushed code is the only way in (no polling) ────────────────────────
s.section("4. no polling — the push is the only hand-off");
const gateSrc = read("app/wpt/qr-gate.tsx");
const gate = code("app/wpt/qr-gate.tsx");
// A countdown timer is legitimate (hide the QR when the link ages out). Polling
// is not: the assertion is that NO timer ever performs a request, and that no
// link status endpoint is ever named.
const timers = gate.match(/set(?:Timeout|Interval)\([\s\S]{0,400}?\n\s*\}\);?/g) || [];
s.check("no timer in the gate performs a request", timers.every((t) => !/fetch\s*\(|registerWebLink|redeemWebLink/.test(t)));
s.check("the only interval is the local expiry countdown", /setInterval/.test(gate) && /expiresAt|countdown|remaining/i.test(gateSrc));
s.check("no link status/claim endpoint is ever named", !/\/api\/link\/(new|status|claim)|claimLink/.test(gate));
s.check("the gate has no mint/confirm call of its own", !/\/confirm|\bmint\(/.test(gate));
s.check("the gate is driven by the pushed login (onLogin)", /onLogin/.test(gate));
s.check("the gate redeems the code it was pushed, and only that", /redeemWebLink/.test(gate) && /code/.test(gate));
s.check("the gate registers BEFORE it has anything to render a QR from", /await registerWebLink\(\)/.test(gate));
s.check("the QR is rendered in the browser from the token it registered", /qrDataUrl = await webLinkQrDataUrl\(webLinkQrPayload\(live\.token\)\)/.test(gate));
s.check("no route hands the browser a server-rendered QR image", !/qrDataUrl|png_data/.test(code("app/api/link/register/route.ts") + code("app/api/link/redeem/route.ts")));
s.check("a registration failure renders no QR", /qrError|\berror\b/.test(gate));
s.check("a lost channel starts a fresh cycle (new token), never a re-poll", /onChannelLost/.test(gate));
s.check("the gate opens the existing realtime namespace with the link ticket", /openLinkChannel/.test(gate) && /linkTicket/.test(gate));
s.check("the client dials the backend origin the BFF gave it", /createRealtimeClient\(\{ baseUrl: realtimeBaseUrl, linkTicket \}\)/.test(client));
s.check("a malformed pushed code is ignored (never redeemed)", /isWebLinkToken\(push\.code\)/.test(client));
s.check("channel loss is surfaced, not worked around by polling", /onChannelLost/.test(client) && /connect_error/.test(client));

// ── 5. redemption: code in, cookie out, credential never in JS ───────────────
s.section("5. redemption hands over the cookie and nothing else");
const redeemRoute = read("app/api/link/redeem/route.ts");
s.check("the redeem route exchanges the code server-to-server", /webLink|redeem|apiClient|API_BASE_URL/.test(redeemRoute));
s.check("the redeem route sets the HttpOnly session cookie", /setSessionCookie/.test(redeemRoute) || /HttpOnly/i.test(redeemRoute));
s.check("the browser posts ONLY the code", /body: JSON\.stringify\(\{ code \}\)/.test(client));
s.check("the browser never receives a session credential", !/sessionToken|webToken|accessToken|refreshToken/.test(client));
s.check("the redeemed result is display identity only", /userId/.test(client) && /accountName/.test(client) && /webSessionId/.test(client) && /deviceId/.test(client));
s.check("a spent/expired code is a failure variant, not a half-session", /body\.ok !== true/.test(client) && /redeem_failed/.test(client));
s.check("the redeem route does not set a JS-readable cookie", !/document\.cookie/.test(redeemRoute));
s.check("the page holds no session credential of its own", !/document\.cookie|localStorage|sessionStorage/.test(gate));

// ── 6. one BFF surface, one backend authority ────────────────────────────────
s.section("6. single implementation / single switch");
const apiRoutes = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/route\.(ts|tsx|js)$/.test(e.name)) apiRoutes.push(full);
  }
})(path.join(APP, "app", "api"));
const routePaths = apiRoutes
  .map((f) => "/" + path.relative(path.join(APP, "app", "api"), f).replace(/\\/g, "/").replace(/\/route\.(ts|tsx|js)$/, "").replace(/^$/, ""))
  .filter(Boolean);
s.check("the only link routes are /api/link/register and /api/link/redeem", routePaths.filter((p) => p.startsWith("/link")).sort().join(",") === "/link/redeem,/link/register");
s.check("the retired backend-mint route is gone", !routePaths.includes("/link/new") && !routePaths.some((p) => p.includes("claim")));
s.check("the session/ticket route the chat client needs is still present", routePaths.includes("/session/ticket"));
const webSources = [
  ...apiRoutes.map((f) => code(path.relative(APP, f).replace(/\\/g, "/"))),
  gate,
  client,
  code("app/lib/web-link-token.ts"),
].join("\n");
s.check("no Web source polls or opens a raw socket for a link", !/claimLink|qrSession/.test(webSources) && !/new WebSocket\(/.test(webSources) && (gate.match(/setInterval\(/g) || []).length === 1);
s.check("that single interval is the expiry countdown, not a poller", /setInterval/.test(gate) && /expiresAt/.test(gate) && timers.every((t) => !/fetch\s*\(|registerWebLink|redeemWebLink/.test(t)));
s.check("no Web source mints or derives a link token", !/api\/link\/new|makeQr|randomBytes|getRandomValues/.test(webSources.replace(/crypto\.getRandomValues\(bytes\)/g, "")));
s.check("only the import-free token module touches an entropy source", /crypto\.getRandomValues\(bytes\)/.test(webSources) && !/crypto\.getRandomValues/.test(code("app/lib/web-link-client.ts")));
const relay = code("server/wpt-server.mjs");
s.check("the chat relay implements no link protocol", !/api\/link\/(new|register|redeem|approve)|qrSession|accountLinked|qrExpired/.test(relay));
s.check("the chat relay lost its QR page and QR PNG generator", !/phonePage|toDataURL|QRCode/.test(relay));
s.check("the chat relay still serves the whole chat contract", /api\/messages\/send/.test(relay) && /synced-contacts/.test(relay) && /webForceLoggedOut/.test(relay) && /session\\\/validate/.test(relay));
s.check("the chat relay keeps its web-session rooms for chat", /web:\$\{w[tT]\}/.test(read("server/wpt-server.mjs")));
s.check("API_BASE_URL is the canonical backend switch", /API_BASE_URL/.test(read("app/lib/web-link-server.ts")));
s.check("the app has exactly one linking entry point (the gate)", /registerWebLink/.test(gate) && !/registerWebLink/.test(code("app/wpt/web-app.tsx")));

// ── 7. the QR payload the phone scans is unchanged ────────────────────────────
s.section("7. QR payload is the phone's existing parser shape");
s.check("the QR encodes wpt://link/<token>", webLinkQrPayload("c".repeat(64)) === `wpt://link/${"c".repeat(64)}`);
s.check("the shared prefix is wpt://link/", WEB_LINK_QR_PREFIX === "wpt://link/");
s.check("the shared parser round-trips our token", parseWebLinkQrPayload(webLinkQrPayload("d".repeat(64))) === "d".repeat(64));
const mobile = fs.readFileSync(path.join(APP, "..", "mobile", "lib", "web-link.ts"), "utf8");
s.check("the mobile parser still reads wpt://link/ + a 64-hex token", /wpt:\/\/link\//.test(mobile) && /64/.test(mobile));
const qr = code("app/lib/web-link-qr.ts");
s.check("the QR renderer only encodes a URI it is handed", /toDataURL/.test(qr) && !/random|getRandomValues|Math\./.test(qr));
s.check("the QR renderer has no idea what a token is", !/token|identity/.test(qr));
s.check("the QR pixels exist only after registration (client-side render)", /await webLinkQrDataUrl\(webLinkQrPayload\(live\.token\)\)/.test(gate) && !/webLinkQrDataUrl/.test(webSources.replace(gate, "")));

// ── 8. the event + route contract the channel listens for ─────────────────────
s.section("8. push event and API surface contract");
s.check("the backend push event is named webLinkLogin", WEB_LINK_EVENTS.login === "webLinkLogin");
s.check("the client subscribes to exactly that event", /WEB_LINK_EVENTS\.login/.test(client));
s.check("the push carries a code the client can validate", /push\.code/.test(client) && /isWebLinkToken/.test(client));
s.check("the shared HTTP surface is register/redeem only (no mint/claim)", Object.values(WEB_LINK_API).every((v) => !/mint|claim/.test(String(v))) && Object.values(WEB_LINK_API).some((v) => /register/.test(String(v))));
s.check("the link TTL is the shared 60s, not a Web-local copy", WEB_LINK_TTL_MS === 60_000 && /ttlMs: WEB_LINK_TTL_MS|ttlMs/.test(client));

s.summary();
process.exit(0);
