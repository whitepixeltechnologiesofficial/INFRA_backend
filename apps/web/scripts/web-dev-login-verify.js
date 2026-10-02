// Dev-only QR test login - verification.
//
// Covers the whole development affordance end to end as far as is possible
// without a phone: the pure contract, the QR screen wiring, the server route,
// and the LAN configuration.
//
//   A. the pure contract (real TS): the phone allowlist, the development-mode
//      gate, loopback rejection, origin resolution and the URL that gets encoded;
//   B. the QR screen: it draws the plain http(s) code ADDITIVELY, next to the
//      real wpt:// one, compiles out of production, and carries no credential;
//   C. the route: server-side dev gate, allowlist, and the real
//      register -> approve -> redeem -> HttpOnly-cookie protocol with no socket;
//   D. the production path is untouched: real QR payload, /api/link/register and
//      /api/link/redeem, the push-based browser channel, and the credential-free
//      production approve response;
//   E. LAN reachability: the dev server binds 0.0.0.0, cross-origin dev requests
//      are allowed, the origin is configurable, and no developer's LAN address is
//      committed anywhere.
//
// Run: node scripts/web-dev-login-verify.js   (plain Node >= 22.7;
//      node --import tsx scripts/web-dev-login-verify.js)

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Suite } from "./_h.mjs";
import {
  DEV_TEST_DEVICE_ID,
  DEV_TEST_LOGIN_PATH,
  DEV_TEST_PHONES,
  buildDevTestLoginUrl,
  devQrUnavailableReason,
  devTestLoginAllowed,
  devTestPhone,
  devTestPhoneList,
  isLoopbackHost,
  normalizeDevPhone,
  resolveDevQrOrigin,
} from "../app/lib/dev-test-login.ts";
import { isWebLinkToken, webLinkQrPayload } from "../../../packages/shared/src/web-link.ts";

const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (f) => fs.readFileSync(path.join(APP, f), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const TEST_PHONE = "9876543210";
const WRONG_PHONE = "1234567890";

const t = new Suite("dev test login verify");

// ───────────────────────────────────────────── A. the pure contract
t.section("A - the allowlist, the dev gate, and the encoded address");

t.check("exactly one test phone is allowlisted", devTestPhoneList().length === 1 && devTestPhoneList()[0] === TEST_PHONE, devTestPhoneList());
t.check("the allowlisted entry is the requested phone", DEV_TEST_PHONES.some((p) => p.digits === TEST_PHONE));
t.check("...with a display label", typeof DEV_TEST_PHONES[0]?.label === "string" && DEV_TEST_PHONES[0].label.length > 0);
t.check("...and an E.164 form for the backend lookup", DEV_TEST_PHONES[0]?.e164 === "+919876543210", DEV_TEST_PHONES[0]?.e164);

// The allowlist is a PHONE list. It used to carry a userId and a display name —
// a hard-coded account the frontend asserted to the backend. The account now
// comes from the backend's real user store, so this module must not be able to
// name an identity at all, whatever the entry happens to look like today.
const entryKeys = new Set(Object.keys(DEV_TEST_PHONES[0] ?? {}));
t.check("the allowlist carries NO userId field", !entryKeys.has("userId"), [...entryKeys]);
t.check("...no accountName field", !entryKeys.has("accountName"), [...entryKeys]);
t.check("...and no identity-shaped field of any kind", ![...entryKeys].some((k) => /user|account|name|display|person|login/i.test(k) && k !== "label"), [...entryKeys]);
t.check("every allowlist entry is identity-free", DEV_TEST_PHONES.every((p) => !("userId" in p) && !("accountName" in p)), DEV_TEST_PHONES);

t.check("the listed phone resolves to its entry", devTestPhone(TEST_PHONE)?.digits === TEST_PHONE);
t.check("common separators are normalized first", devTestPhone("98765 43210")?.digits === TEST_PHONE);
t.check("a +country prefix is normalized first", devTestPhone("+919876543210")?.digits === TEST_PHONE);
t.check("an outdial-style prefix is normalized first", devTestPhone("00919876543210")?.digits === TEST_PHONE);
t.check("...and only that entry's declared international form", devTestPhone("+447700900123") === null && devTestPhone("001199876543210") === null);

t.check("a wrong phone is refused, never mapped to a default", devTestPhone(WRONG_PHONE) === null);
t.check("garbage is refused", devTestPhone("not-a-phone") === null && devTestPhone("") === null && devTestPhone(null) === null);
t.check("an over-long digit string is refused", devTestPhone("999999999999999999") === null);
t.check("a real 10-digit US number is refused", devTestPhone("4155552671") === null);
t.check("digit extraction keeps digits and drops the rest", normalizeDevPhone("  +91 (98765) 432-10 ") === "919876543210");

t.check("production is NOT development", devTestLoginAllowed("production") === false);
t.check("development is development", devTestLoginAllowed("development") === true);
t.check("an unset NODE_ENV (tsx, tests) counts as development", devTestLoginAllowed(undefined) === true && devTestLoginAllowed("") === true);

for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.4.5.6", "0.0.0.0", "::1", "::", "[::1]", "my-mac.local"]) {
  t.check(`loopback/unroutable host rejected: ${host}`, isLoopbackHost(host) === true);
}
t.check("a real LAN address is accepted", isLoopbackHost("192.168.1.10") === false);
t.check("another LAN address is accepted", isLoopbackHost("10.0.0.42") === false);

t.check("the configured LAN origin wins over the page origin", resolveDevQrOrigin("http://192.168.1.10:3000", "http://localhost:3000").origin === "http://192.168.1.10:3000");
t.check("with nothing configured, the page's own origin is used", resolveDevQrOrigin(undefined, "http://192.168.1.10:3000").origin === "http://192.168.1.10:3000");
t.check("...which is how a LAN-opened page needs zero configuration", resolveDevQrOrigin("", "http://192.168.1.10:3000").problem === null);
t.check("a trailing path is dropped (only the origin is kept)", resolveDevQrOrigin("http://192.168.1.10:3000/some/path", null).origin === "http://192.168.1.10:3000");
t.check("a configured loopback origin is refused", resolveDevQrOrigin("http://localhost:3000", "http://192.168.1.10:3000").problem === "loopback");
t.check("...and 127.0.0.1 likewise", resolveDevQrOrigin("http://127.0.0.1:3000", null).problem === "loopback");
t.check("a malformed origin is refused", resolveDevQrOrigin("192.168.1.10:3000", null).problem === "malformed");
t.check("a non-http scheme is refused", resolveDevQrOrigin("ftp://192.168.1.10:3000", null).problem === "malformed");
t.check("neither configured nor page origin leaves nothing to draw", resolveDevQrOrigin(undefined, null).problem === "unset");
t.check("the refusal reason is human-readable, and names the variable", /NEXT_PUBLIC_DEV_QR_ORIGIN/.test(devQrUnavailableReason(resolveDevQrOrigin("http://localhost:3000", null))));
t.check("the unset reason is human-readable too", devQrUnavailableReason(resolveDevQrOrigin(undefined, null)).length > 10);

const built = buildDevTestLoginUrl("http://192.168.1.10:3000", TEST_PHONE);
t.check("the encoded URL is the plain LAN http address", built === `http://192.168.1.10:3000${DEV_TEST_LOGIN_PATH}?phone=${TEST_PHONE}`, built);
t.check("no code can be built from a loopback origin", buildDevTestLoginUrl("http://localhost:3000", TEST_PHONE) === null);
t.check("no code can be built for an unlisted phone", buildDevTestLoginUrl("http://192.168.1.10:3000", WRONG_PHONE) === null);
t.check("the URL carries only the phone - no token, OTP, PIN, key or session", /^[a-z]+:\/\/[^/?]+\/dev\/test-login\?phone=\d{10}$/.test(built ?? ""));
t.check("...and nothing in the URL looks like a credential", !/token|code|otp|pin|secret|key|session|auth/i.test(built ?? ""));
t.check("the path constant matches the route directory", DEV_TEST_LOGIN_PATH === "/dev/test-login");

// ───────────────────────────────────────────── B. the QR screen
t.section("B - the QR screen draws both codes, and only one of them exists in production");

const gate = read("app/wpt/qr-gate.tsx");
const gateCode = strip(gate);

t.check("the real wpt:// code is still drawn", gateCode.includes("webLinkQrDataUrl(webLinkQrPayload(") || /webLinkQrPayload\(/.test(gateCode));
t.check("...and the real registration still happens in the browser", gateCode.includes("registerWebLink(") && gateCode.includes("redeemWebLink("));
t.check("...and the browser still waits for the PUSHED code", gateCode.includes("openLinkChannel("));
t.check("the dev code is drawn beside it, not instead of it", /DevTestLoginCode/.test(gateCode));
t.check("the dev block is gated on NODE_ENV", /DEV_QR_ENABLED\s*=\s*process\.env\.NODE_ENV\s*!==\s*"production"/.test(gateCode));
t.check("...and is only mounted when that gate is on", /\{DEV_QR_ENABLED\s*\?\s*<DevTestLoginCode\s*\/>\s*:\s*null\}/.test(gateCode));
t.check("the dev code is rendered with the maintained qrcode helper", /webLinkQrDataUrl\(built\)/.test(gateCode));
t.check("...never with a hand-rolled encoder", !/qrcode\.toDataURL|QRCode\(|new QRCode/.test(gateCode));
t.check("the dev URL comes from the one tested builder", gateCode.includes("buildDevTestLoginUrl(") && gateCode.includes("resolveDevQrOrigin("));
t.check("the dev block refuses to draw from loopback", gateCode.includes("devQrUnavailableReason("));
t.check("the account list is read from the shared allowlist", gateCode.includes("devTestPhoneList("));

const css = read("app/globals.css");
t.check("the dev code has styles in the product's own tokens", /\.qr-dev\b/.test(css) && /\.qr-dev-img/.test(css) && /var\(--accent\)/.test(css));
t.check("...and it is labelled, so it cannot be mistaken for the real code", /qr-dev-tag/.test(css) || /Dev only/.test(gate));
t.check("the dev code is responsive (small enough for a phone to scan)", /width:\s*1\d\dpx/.test(css));

// ───────────────────────────────────────────── C. the dev route
t.section("C - the route: development-only, allowlisted, and the real protocol without a socket");

const routeRaw = read("app/dev/test-login/route.ts");
const route = strip(routeRaw);

t.check("the route is server-side", /export const runtime\s*=\s*"nodejs"/.test(route));
t.check("...and uncached", /export const dynamic\s*=\s*"force-dynamic"/.test(route));
t.check("it only answers GET", /export async function GET\(/.test(route) && !/export async function POST\(/.test(route));
t.check("it refuses production outright, before anything else", route.indexOf("devTestLoginAllowed(process.env.NODE_ENV)") < route.indexOf("webLinkApi()"));
t.check("...and says 404, not 403: it must not exist in production", /devError\(404/.test(routeRaw));
t.check("the phone is resolved from the shared allowlist", route.includes("devTestPhone(") && route.includes("normalizeDevPhone("));
t.check("an unlisted phone is refused with a 400", route.includes("devError(400"));
t.check("...and the refusal lists the allowed numbers", route.includes("devTestPhoneList("));
t.check("the route never invents an account for an unknown phone", !/mobileUserId:\s*["'`]/i.test(route));

t.check("it registers a link through the normal client seam", route.includes("webLinkApi().register("));
t.check("...using the one CSPRNG token generator", route.includes("generateWebLinkToken("));
t.check("...and a real ed25519 public bundle", route.includes("generateIdentityKeyPair(") && route.includes("devIdentityBundle()"));
t.check("...whose private key is discarded in-module", /const pair = generateIdentityKeyPair\(\);[\s\S]{0,200}?return \{ version: 1, publicKey/.test(route) && !/privateKey/.test(strip(route).split("devIdentityBundle")[1]?.slice(0, 400) ?? ""));
t.check("it approves through the backend's own dev trigger", route.includes("dev.simulateScan("));
t.check("...asking for the code inline, because it has no socket to be pushed to", /deliverInline:\s*true/.test(route));
const scanCall = route.slice(route.indexOf("dev.simulateScan("), route.indexOf("dev.simulateScan(") + 300);
t.check("the ONLY identity it sends is the phone number, in E.164", /phoneNumber:\s*entry\.e164/.test(route));
t.check("...no userId is sent", !/\bmobileUserId\b/.test(scanCall));
t.check("...and no account name is sent", !/\baccountName\b/.test(scanCall));
t.check("it spends the code through the normal redeem", route.includes("webLinkApi().redeemLink("));
t.check("...and demands a code before redeeming", route.includes("if (!scan.code)"));
t.check("it demands the backend actually issued an account", route.includes("if (!redeemed.userId)"));
t.check("the name it displays comes from the issued session, not from a fixture", /redeemed\.accountName\?\.trim\(\)/.test(route));
t.check("...and falls back to the number when the account has no name yet", /redeemed\.accountName\?\.trim\(\) \|\| entry\.e164/.test(route));
t.check("a backend refusal is surfaced verbatim, so an unknown phone explains itself", route.includes("scan.message?.trim()"));
t.check("the session is handed over ONLY as an HttpOnly cookie", route.includes("setSessionCookie(redeemed.sessionToken)"));
t.check("...and the response is explicitly no-store", route.includes('"Cache-Control": "no-store"'));
t.check("no token, code or session value is ever interpolated into the rendered page", !/\$\{[^}]*\b(token|code|sessionToken|redeemed|registered|scan)\b/.test(routeRaw));

t.check("THE OLD BUG IS GONE: the route no longer opens a realtime channel", !/openLinkChannel|createRealtimeClient|socket\.io|socketio/i.test(route));
t.check("...so it can no longer fail with 'realtime link channel did not come up'", !/realtime link channel did not come up/.test(routeRaw));
t.check("...structurally: it never imports the browser half either", !/web-link-client/.test(route));
t.check("...so socket.io-client is not even in this module's graph", !/@wpt\/api-client/.test(route));
t.check("the browser push path is untouched by all of this", read("app/lib/web-link-client.ts").includes("openLinkChannel"));
t.check("the client never imports the dev route", !/from\s+["'][^"']*dev\/test-login\/route["']/.test(gateCode));
t.check("no shipped client imports the dev route module", !/from ["'][^"']*dev\/test-login\/route["']/.test(read("app/wpt/chat-app.tsx") + read("app/wpt/web-app.tsx") + read("app/lib/web-link-client.ts")));

// ───────────────────────────────────────────── D. production untouched
t.section("D - the production QR and linking path are not weakened");

t.check("the production QR payload is still exactly wpt://link/<64 hex>", webLinkQrPayload("a".repeat(64)) === `wpt://link/${"a".repeat(64)}`);
t.check("...and an opaque token is recognised as one", isWebLinkToken("a".repeat(64)) === true);
t.check("...and the dev path is NOT a valid Web-link token", isWebLinkToken(built ?? "") === false);
t.check("/api/link/register still exists as its own BFF route", fs.existsSync(path.join(APP, "app/api/link/register/route.ts")));
t.check("/api/link/redeem still exists as its own BFF route", fs.existsSync(path.join(APP, "app/api/link/redeem/route.ts")));
t.check("the browser register endpoint is unchanged", /fetch\("\/api\/link\/register"/.test(read("app/lib/web-link-client.ts")));
t.check("the browser redeem endpoint is unchanged", /fetch\("\/api\/link\/redeem"/.test(read("app/lib/web-link-client.ts")));
t.check(
  "the inline code is opt-in on the dev route only (deliverInline === true)",
  /deliverInline === true/.test(read("../backend/src/routes/web-link.ts")),
);
t.check(
  "the production approve response carries no code at all",
  !/deliverInline/.test(strip(fs.readFileSync(path.resolve(APP, "../backend/src/routes/web-link.ts"), "utf8")).split("_dev/scan")[0]),
);

const webLinkSource = fs.readFileSync(path.resolve(APP, "../backend/src/web-link/service.ts"), "utf8");
t.check("the backend still mints the code inside the atomic approve", /approve\(/.test(webLinkSource) && /claimLink\(/.test(webLinkSource));
t.check("the dev-only inline flag is honoured only on the _dev route", /_dev\/scan/.test(read("../backend/src/routes/web-link.ts")));

// ───────────────────────────────────────────── E. LAN reachability
t.section("E - LAN reachability, with no developer address committed");

const pkg = JSON.parse(read("package.json"));
t.check("the dev server binds every interface, so a phone can reach it", /next dev[^\n]*(-H|--hostname)\s+0\.0\.0\.0/.test(pkg.scripts.dev), pkg.scripts.dev);
t.check("...and the production start script is NOT widened to the LAN", pkg.scripts.start === "next start", pkg.scripts.start);

const nextConfig = read("next.config.js");
t.check("cross-origin dev requests are allowed for LAN addresses", /allowedDevOrigins/.test(nextConfig));
t.check("...covering private LAN ranges and mDNS names", /192\.168\./.test(nextConfig) && /\.local/.test(nextConfig));
t.check("...and localhost/127.0.0.1 are still allowed implicitly by Next", /allowedDevOrigins/.test(nextConfig));

const envExample = read(".env.example");
t.check("the LAN origin is configurable via NEXT_PUBLIC_DEV_QR_ORIGIN", /NEXT_PUBLIC_DEV_QR_ORIGIN/.test(envExample));
t.check("...and it ships commented out, not set", /^#\s*NEXT_PUBLIC_DEV_QR_ORIGIN=/m.test(envExample) && !/^NEXT_PUBLIC_DEV_QR_ORIGIN=/m.test(envExample));
t.check("...with an example address, not a real one", /#\s*NEXT_PUBLIC_DEV_QR_ORIGIN=http:\/\/192\.168\.1\.10:3000/.test(envExample));
t.check("the example explains the localhost trap", /localhost/.test(envExample) && /resolves/i.test(envExample));

// No committed developer's own address anywhere in tracked source.
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git"].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js|css|json|html)$/.test(e.name)) out.push(full);
  }
}
const srcFiles = [];
walk(path.join(APP, "app"), srcFiles);
walk(path.join(APP, "server"), srcFiles);
srcFiles.push(path.join(APP, "package.json"), path.join(APP, "next.config.js"));
const ipHits = srcFiles.filter((f) => /192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+/.test(strip(fs.readFileSync(f, "utf8"))));
t.check("no LAN address is hard-coded in any shipped source", ipHits.length === 0, ipHits.map((f) => path.relative(APP, f)));

t.check("no credential is persisted client-side by any of this", !/localStorage|sessionStorage/.test(route) && !/localStorage|sessionStorage/.test(gateCode.replace(/openLinkChannel[\s\S]*?\];/, "")));

// ─────────────────────────────F. a revoked session must not read as "unreachable"
t.section("F - the client's 401 mapping (a bug the live dev-login run exposed)");

// Driving /dev/test-login twice over real HTTP showed the FIRST cookie reporting
// reason:"unreachable" instead of "not_authorized" - i.e. a session that had been
// genuinely revoked was being shown as a connectivity problem, the exact opposite
// of what app/api/session/status documents. Root cause: unwrap let the response
// body's domain code win over the HTTP status, which left its own 401 branch
// unreachable for every code the backend actually sends.
//
// The source invariant is asserted here; the behavioural matrix (every code
// requireWebSession can return) runs in the backend suite, which can import
// @wpt/api-client because it executes under tsx rather than bare Node.
const unwrapSrc = fs.readFileSync(path.resolve(APP, "../../packages/api-client/src/web-link.ts"), "utf8");
const unwrapStart = unwrapSrc.indexOf("async function unwrap");
const unwrapBody = unwrapSrc.slice(unwrapStart, unwrapSrc.indexOf("\n  return {", unwrapStart));
const i401 = unwrapBody.indexOf("status === 401");
const iBodyCode = unwrapBody.indexOf('typeof b.error === "string"');
t.check("401 is decided before any body code is read", i401 !== -1 && iBodyCode !== -1 && i401 < iBodyCode, { i401, iBodyCode });
t.check("...so the domain codes no longer shadow it", !/b\.error !== "INVALID_TOKEN"/.test(unwrapBody));
t.check("...and 410/429 still have their own meanings after it", /status === 410/.test(unwrapBody) && /status === 429/.test(unwrapBody));
t.check("the BFF still distinguishes revoked from unreachable", /res\.error === "not_authorized"/.test(read("app/api/session/status/route.ts")));
t.check("...and still says no_session when there is no cookie at all", /reason: "no_session"/.test(read("app/api/session/status/route.ts")));

// ──────────────G. no hard-coded account identity anywhere in the dev flow
//
// This flow used to assert a fixed account: the allowlist carried a userId and
// a display name, the route passed them to the backend, and the session came
// back for whoever that happened to be. Reproducible, yes — but the account was
// a frontend claim, which is the body-trust R1.3 forbids everywhere else. The
// account is now resolved by the backend from its real user store, so these
// guards exist to keep a hard-coded one from creeping back in.
t.section("G - the account comes from the backend, not from a fixture");

const backendRoutes = fs.readFileSync(path.resolve(APP, "../backend/src/routes/web-link.ts"), "utf8");
const accountLookup = fs.readFileSync(path.resolve(APP, "../backend/src/accounts/account-lookup.ts"), "utf8");

const identityLiterals = [
  ["app/lib/dev-test-login.ts", read("app/lib/dev-test-login.ts")],
  ["app/dev/test-login/route.ts", routeRaw],
  ["app/wpt/qr-gate.tsx", read("app/wpt/qr-gate.tsx")],
].flatMap(([file, src]) => {
  const hits = strip(src).match(/\b(userId|accountName|displayName)\s*[:=]\s*["'`][^"'`]+["'`]/g) ?? [];
  return hits.map((h) => `${file}: ${h}`);
});
t.check("no dev file assigns a literal userId or display name", identityLiterals.length === 0, identityLiterals);
t.check("the dev route reads the signed-in name off the issued session", route.includes("redeemed.accountName"));

t.check("the backend resolves the account server-side", /resolveAccountByPhone/.test(backendRoutes));
t.check("...out of its real user store (users.phone_number)", /eq\(users\.phoneNumber, e164\)/.test(accountLookup) && /users-schema/.test(accountLookup));
t.check("...with no fallback account and no invented one", !/userId:\s*["'`][^"'`]+["'`]/.test(strip(accountLookup)) && /No account exists/.test(accountLookup));
t.check("the store lookup is only ever asked with an E.164 string", /E164_SHAPE/.test(accountLookup) && /E164_SHAPE\.test\(phoneNumber\)/.test(accountLookup));
t.check("a caller cannot override the resolved account in the same request", /phoneNumber !== undefined/.test(backendRoutes) && /mobileUserId: resolved\.account\.userId/.test(backendRoutes));
t.check("an unknown number is refused with a named error", /resolved\.error/.test(backendRoutes) && /account_not_found/.test(accountLookup));
t.check("...and the harness proves it end to end, over the mounted router", /overrideAccountLookup/.test(read("../backend/src/web-link/web-r-1-1-verify.ts")) && /account_not_found/.test(read("../backend/src/web-link/web-r-1-1-verify.ts")));

process.exit(t.summary() ? 0 : 1);
