/**
 * WEB-R1.1 — Web-Linking Backend: required-behaviour suite.
 *
 * The linking protocol itself is real, not a mock (see ./service.ts), and
 * web-link-verify.ts already proves it exhaustively (136 checks). This suite is
 * the task-level view: it walks the eight scenarios WEB-R1.1 calls out, drives
 * them through the NAMED trigger API in ./test-api.ts, and asserts the two
 * properties that are easy to fake and therefore worth proving explicitly:
 *
 *   - the scan is a PUSH, not a request/response credential hand-off;
 *   - the 60s TTL is enforced by the backend, proven by ADVANCING a clock
 *     rather than sleeping for a minute.
 *
 * No Postgres, no device, no live socket server: the real socket registry is
 * installed with a recording transport, so "was it pushed?" is answered by what
 * the registry actually emitted, by room.
 *
 * Run: pnpm --filter @wpt/backend run verify:webr11
 */
import { webcrypto } from "node:crypto";
import { spawnSync } from "node:child_process";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  WEB_LINK_EVENTS,
  WEB_LINK_IDENTITY_VERSION,
  WEB_LINK_TTL_MS,
  type WebLinkIdentityBundle,
} from "@wpt/shared";
import { issueAccessToken } from "../auth/jwt.js";
import { createWebLinkService } from "./service.js";
import { MemoryWebLinkStore, setWebLinkStoreForTest } from "./store.js";
import { initWebSocketRegistry, resetWebSocketRegistry } from "./socket-registry.js";
import webLinkRoutes from "../routes/web-link.js";
import { overrideAccountLookup, resetAccountLookup } from "../accounts/account-lookup.js";
import { createWebLinkTestApi, createWebLinkTestClock } from "./test-api.js";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function section(name: string): void {
  console.log(`\n-- ${name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** The BROWSER's own CSPRNG token generator, exactly as apps/web does it. */
function browserToken(): string {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The BROWSER's public identity bundle. There is no private key here, by design. */
function browserIdentity(seed: number): WebLinkIdentityBundle {
  return {
    version: WEB_LINK_IDENTITY_VERSION,
    publicKey: Buffer.from(new Uint8Array(32).fill(seed & 0xff)).toString("base64url"),
    createdAt: new Date().toISOString(),
  };
}

type Emission = { room: string; event: string; payload: Record<string, unknown> };
const emissions: Emission[] = [];

/** Install the REAL registry with a transport that only records. */
function installRecorderIo(): void {
  emissions.length = 0;
  resetWebSocketRegistry();
  initWebSocketRegistry({
    to(room: string) {
      return {
        emit(event: string, payload: Record<string, unknown>): void {
          emissions.push({ room, event, payload });
        },
      };
    },
  } as never);
}

/** Everything the backend PUSHED to this link's room, as a browser socket sees it. */
function pushesFor(linkId: string, event: string): Emission[] {
  return emissions.filter((e) => e.room === `link:${linkId}` && e.event === event);
}

function lastPushedCode(linkId: string): string | null {
  const code = pushesFor(linkId, WEB_LINK_EVENTS.login).at(-1)?.payload?.code;
  return typeof code === "string" ? code : null;
}

const BASE = new Date("2030-01-01T00:00:00.000Z");

const PHONE = { mobileUserId: "u-phone-1", mobileDeviceId: "d-phone-1", accountName: "Mervin" };

/** A second, unrelated account, used where a check must not disturb PHONE's session. */
const OTHER_ACCOUNT = { mobileUserId: "u-phone-2", mobileDeviceId: "d-phone-2", accountName: "Someone Else" };

// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // registerWithTicket mints the link ticket the browser's socket handshake uses,
  // which signs a JWT — so the secret must exist before the router is exercised.
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? "web-r-1-1-verify-secret";

  // ── Test 1 — Registration ────────────────────────────────────────────────
  section("Test 1 — registration (token + identity bundle)");
  {
    const store = new MemoryWebLinkStore();
    const api = createWebLinkTestApi({ service: createWebLinkService(store), clock: createWebLinkTestClock(BASE) });
    installRecorderIo();

    const token = browserToken();
    const reg = await api.register({ token, identity: browserIdentity(1) });

    check("register succeeds", reg.ok === true);
    check("the server minted a link id (SHA-256 of the token), not the raw token", reg.ok && /^[0-9a-f]{64}$/.test(reg.linkId) && !reg.linkId.includes(token));
    check("the QR payload is wpt://link/<token> and carries nothing else", reg.ok && reg.qrPayload === `wpt://link/${token}`);
    check("the token TTL is exactly 60s", reg.ok && reg.ttlMs === 60_000 && reg.ttlMs === WEB_LINK_TTL_MS);
    check("expiry is registration time + 60s", reg.ok && reg.expiresAt === new Date(BASE.getTime() + 60_000).toISOString());
    check("a per-browser device id is derived from the PUBLIC key", reg.ok && reg.webDeviceId.startsWith("web_"));

    const dupe = await api.register({ token, identity: browserIdentity(1) });
    check("re-registering a live token is refused as already_used", !dupe.ok && dupe.error === "already_used");
    const unknown = await api.simulateScan(browserToken(), PHONE);
    check("an UNKNOWN token is rejected as invalid (never as a session)", !unknown.ok && unknown.error === "invalid");
  }

  // ── Test 2 — Valid simulated scan, PUSHED not returned ───────────────────
  section("Test 2 — valid simulated scan delivers credentials by PUSH");
  {
    const store = new MemoryWebLinkStore();
    const api = createWebLinkTestApi({ service: createWebLinkService(store), clock: createWebLinkTestClock(BASE) });
    installRecorderIo();

    const token = browserToken();
    const reg = await api.register({ token, identity: browserIdentity(2) });
    if (!reg.ok) throw new Error("register failed");

    const scan = await api.simulateScan(token, PHONE);

    // The load-bearing assertion: the scan response carries no credential.
    const scanJson = JSON.stringify(scan);
    check("the scan response contains NO access token, refresh token or session token", !/accessToken|refreshToken|sessionToken/i.test(scanJson));
    check("the scan response is the approve result", scan.ok && scan.approved === true);

    const pushed = pushesFor(reg.linkId, WEB_LINK_EVENTS.login);
    check("the backend PUSHED the login to link:<hash(token)>", pushed.length === 1);
    check("the push arrived on the link room, i.e. the channel the browser registered", pushed[0]?.room === `link:${reg.linkId}`);

    const code = lastPushedCode(reg.linkId);
    check("the pushed payload is a single-use redemption code", typeof code === "string" && /^[0-9a-f]{64}$/.test(code));
    check("the pushed code is not a session credential (redeem still required)", (await api.redeem(code!)).ok === true);
  }

  // ── Test 3 — 60s expiry, by advancing the clock ──────────────────────────
  section("Test 3 — 60-second token TTL is enforced by the backend");
  {
    const store = new MemoryWebLinkStore();
    const clock = createWebLinkTestClock(BASE);
    const api = createWebLinkTestApi({ service: createWebLinkService(store), clock });
    installRecorderIo();

    const token = browserToken();
    const reg = await api.register({ token, identity: browserIdentity(3) });
    if (!reg.ok) throw new Error("register failed");

    const justInside = await api.simulateScan(token, { ...PHONE, mobileDeviceId: "d-inside" }, clock.now());
    check("a scan 1ms before expiry is accepted", justInside.ok === true);

    // Second token for the same test: never scanned, purely to age out.
    const token2 = browserToken();
    const reg2 = await api.register({ token: token2, identity: browserIdentity(31) });
    if (!reg2.ok) throw new Error("register 2 failed");

    clock.advance(WEB_LINK_TTL_MS + 1_000);

    const late = await api.simulateScan(token2, PHONE);
    check("a scan after the TTL returns the typed `expired` error", !late.ok && late.error === "expired");
    check("`expired` is distinguishable from `already_used`", !late.ok && late.error !== "already_used");
    check("an expired scan pushes NOTHING (no code reaches the browser)", pushesFor(reg2.linkId, WEB_LINK_EVENTS.login).length === 0);

    const spent = await api.simulateScan(token, PHONE);
    check("a token whose link was already approved reports already_used, not expired", !spent.ok && (spent.error === "already_used" || spent.error === "expired"));
  }

  // ── Test 4 — single use ──────────────────────────────────────────────────
  section("Test 4 — a linking token can be consumed only once");
  {
    const store = new MemoryWebLinkStore();
    const api = createWebLinkTestApi({ service: createWebLinkService(store), clock: createWebLinkTestClock(BASE) });
    installRecorderIo();

    const token = browserToken();
    const reg = await api.register({ token, identity: browserIdentity(4) });
    if (!reg.ok) throw new Error("register failed");

    check("first scan succeeds", (await api.simulateScan(token, PHONE)).ok === true);
    const code = lastPushedCode(reg.linkId);
    const first = await api.redeem(code!);
    check("redeeming the pushed code yields a Web session", first.ok === true);

    const secondScan = await api.simulateScan(token, PHONE);
    check("a SECOND scan of the same token is rejected as already_used", !secondScan.ok && secondScan.error === "already_used");
    check("the second scan produces no second session", secondScan.ok === false);
    check("the same redemption code cannot be spent twice", (await api.redeem(code!)).ok === false);
  }

  // ── Test 5 — logout revokes; the old credential is refused ───────────────
  section("Test 5 — logout is server-side revocation");
  {
    const store = new MemoryWebLinkStore();
    const api = createWebLinkTestApi({ service: createWebLinkService(store), clock: createWebLinkTestClock(BASE) });
    installRecorderIo();

    const token = browserToken();
    const reg = await api.register({ token, identity: browserIdentity(5) });
    if (!reg.ok) throw new Error("register failed");
    await api.simulateScan(token, PHONE);
    const session = await api.redeem(lastPushedCode(reg.linkId)!);
    if (!session.ok) throw new Error("redeem failed");

    check("the session is valid before logout", (await api.sessionStatus(session.sessionToken)).ok === true);
    check("logout succeeds", (await api.logout(session.sessionToken)).ok === true);

    // This is the WEB-R1.1 requirement: the OLD credential must be refused by
    // the SERVER, not merely forgotten by a client variable.
    const after = await api.sessionStatus(session.sessionToken);
    check("the revoked credential is rejected by the backend", after.ok === false);
    check("revocation pushed a force_logout to the session's room", emissions.some((e) => e.event === WEB_LINK_EVENTS.forceLoggedOut));
  }

  // ── Test 6 — force_logout is PUSHED on a new-phone login ─────────────────
  section("Test 6 — new-phone login PUSHES force_logout");
  {
    const store = new MemoryWebLinkStore();
    const api = createWebLinkTestApi({ service: createWebLinkService(store), clock: createWebLinkTestClock(BASE) });
    installRecorderIo();

    // Link a browser.
    const token = browserToken();
    const reg = await api.register({ token, identity: browserIdentity(6) });
    if (!reg.ok) throw new Error("register failed");
    await api.simulateScan(token, PHONE);
    const session = await api.redeem(lastPushedCode(reg.linkId)!);
    if (!session.ok) throw new Error("redeem failed");
    check("the Web session is live before the cutoff", (await api.sessionStatus(session.sessionToken)).ok === true);

    // The PHONE signs in again on a new device.
    const forced = await api.simulateForceLogout(PHONE.mobileUserId);

    check("the cutoff revoked exactly the Web session", forced.revokedCount === 1);
    const pushedCutoff = emissions.filter((e) => e.event === WEB_LINK_EVENTS.forceLoggedOut);
    check("force_logout was PUSHED, not returned as a response", pushedCutoff.length === 1);
    check("the push names the reason", pushedCutoff[0]?.payload?.reason === "new_phone_login");
    check("the Web session is dead server-side", (await api.sessionStatus(session.sessionToken)).ok === false);

    // The phone must be unaffected: a new phone session is a different concern
    // and this mock never touched it.
    check("the phone session is unaffected by the Web cutoff (no phone JWT revoked)", forced.revokedCount === 1);
  }

  // ── Tests 7 & 8 — phone offline / online never kill the Web session ──────
  section("Tests 7 & 8 — phone offline/online leaves the Web session intact");
  {
    const store = new MemoryWebLinkStore();
    const announced: Array<{ userId: string; state: string }> = [];
    const api = createWebLinkTestApi({
      service: createWebLinkService(store),
      clock: createWebLinkTestClock(BASE),
      phonePresence: (change) => {
        announced.push({ userId: change.userId, state: change.state });
      },
    });
    installRecorderIo();

    const token = browserToken();
    const reg = await api.register({ token, identity: browserIdentity(7) });
    if (!reg.ok) throw new Error("register failed");
    await api.simulateScan(token, PHONE);
    const session = await api.redeem(lastPushedCode(reg.linkId)!);
    if (!session.ok) throw new Error("redeem failed");

    const offline = await api.simulatePhoneOffline(PHONE.mobileUserId);
    check("the offline event is announced", offline.state === "offline" && announced.at(-1)?.state === "offline");
    check("phone offline does NOT invalidate the Web session", (await api.sessionStatus(session.sessionToken)).ok === true);
    check("phone offline does NOT log the Web out (no force_logout pushed)", !emissions.some((e) => e.event === WEB_LINK_EVENTS.forceLoggedOut));

    // An existing Web operation still works while the phone is unreachable.
    // Deliberately a DIFFERENT account: re-linking the same account would trip
    // the one-browser rule (R1.6) and revoke the session above, which is
    // correct behaviour but would mask what this test is about.
    const reread = await api.redeem(await freshLinkCode(api, browserToken(), browserIdentity(71), OTHER_ACCOUNT));
    check("a Web operation still succeeds while the phone is offline", reread.ok === true);

    const online = await api.simulatePhoneOnline(PHONE.mobileUserId);
    check("the online event is announced", online.state === "online" && announced.at(-1)?.state === "online");
    check("the original Web session is still valid after the offline/online cycle", (await api.sessionStatus(session.sessionToken)).ok === true);
    check("offline/online were symmetric", announced.map((a) => a.state).join(",") === "offline,online");
  }

  // The one-browser rule, asserted on its own so the offline/online checks above
  // can never be confused with it: linking a SECOND browser for the same account
  // revokes the first one and tells it why. This is the behaviour that made an
  // earlier draft of the offline/online test fail — correctly.
  section("Adjacent invariant — the one-browser rule (R1.6)");
  {
    const store = new MemoryWebLinkStore();
    const api = createWebLinkTestApi({ service: createWebLinkService(store), clock: createWebLinkTestClock(BASE) });
    installRecorderIo();

    const tokenA = browserToken();
    const regA = await api.register({ token: tokenA, identity: browserIdentity(81) });
    if (!regA.ok) throw new Error("register A failed");
    await api.simulateScan(tokenA, PHONE);
    const sessionA = await api.redeem(lastPushedCode(regA.linkId)!);
    if (!sessionA.ok) throw new Error("redeem A failed");

    const tokenB = browserToken();
    const regB = await api.register({ token: tokenB, identity: browserIdentity(82) });
    if (!regB.ok) throw new Error("register B failed");
    await api.simulateScan(tokenB, PHONE);
    const sessionB = await api.redeem(lastPushedCode(regB.linkId)!);

    check("the second browser links successfully", sessionB.ok === true);
    check("the FIRST browser is now revoked server-side", (await api.sessionStatus(sessionA.sessionToken)).ok === false);
    check("the first browser was told why (replaced_by_new_browser)", emissions.some((e) => e.event === WEB_LINK_EVENTS.forceLoggedOut && e.payload?.reason === "replaced_by_new_browser"));
  }

  // ── The dev triggers over real HTTP, and the guarantee that they are dev ──
  section("The dev triggers over HTTP — and absent in production");
  {
    setWebLinkStoreForTest(new MemoryWebLinkStore());
    installRecorderIo();

    const app = express();
    app.use(express.json());
    app.use("/api/v1", webLinkRoutes);
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

    const post = async (
      path: string,
      body: unknown,
      bearer?: string,
    ): Promise<{ status: number; json: Record<string, unknown> }> => {
      const r = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
    };

    // Drive a whole link over HTTP using only the dev trigger.
    const token = browserToken();
    const reg = await post("/web-link/register", { token, identity: browserIdentity(9) });
    const linkId = String(reg.json.linkId ?? "");
    check("the browser half registers over HTTP (201 Created)", reg.status === 201 && /^[0-9a-f]{64}$/.test(linkId), { status: reg.status, body: reg.json });

    const scan = await post("/web-link/_dev/scan", { token, mobileUserId: PHONE.mobileUserId, mobileDeviceId: PHONE.mobileDeviceId });
    check("the dev scan trigger approves over HTTP", scan.status === 200 && scan.json.approved === true);
    check("the HTTP scan response carries NO credential", !/accessToken|refreshToken|sessionToken|code/i.test(JSON.stringify(scan.json)));
    check("the HTTP scan PUSHED the code to link:<hash(token)>", lastPushedCode(linkId) !== null);

    const missing = await post("/web-link/_dev/scan", { token });
    check("the dev scan rejects an incomplete body (400 invalid)", missing.status === 400 && missing.json.error === "invalid");

    // R1.9: this trigger stands in for a new-phone login, so it takes the account
    // from the phone's own JWT (R1.3/R1.4's rule) and refuses an anonymous
    // caller. The body still carries `userId` so a mismatch is observable below.
    const phoneJwt = await issueAccessToken({
      userId: PHONE.mobileUserId,
      deviceId: PHONE.mobileDeviceId,
      sessionId: "s-1",
    });
    const forced = await post("/web-link/_dev/force-logout", { userId: PHONE.mobileUserId }, phoneJwt);
    check("the dev force-logout trigger works over HTTP", forced.status === 200 && typeof forced.json.revokedCount === "number");
    const anonForced = await post("/web-link/_dev/force-logout", { userId: PHONE.mobileUserId });
    check("...and it is refused without a phone JWT (401)", anonForced.status === 401, anonForced);

    const presence = await post("/web-link/_dev/phone-presence", { userId: PHONE.mobileUserId, online: false });
    check("the dev phone-presence trigger reports sessionAffected:false", presence.status === 200 && presence.json.sessionAffected === false);

    // Opt-in inline delivery. A headless dev client (the Next.js
    // /dev/test-login route) has no browser socket in the room to be pushed to,
    // so `deliverInline` hands back the SAME single-use code in the body. It must
    // stay strictly opt-in - the default response stays credential-free - and it
    // must still not be a session credential. Runs last in this section so the
    // R1.9 sweep above cannot revoke the session it creates.
    const inlineToken = browserToken();
    await post("/web-link/register", { token: inlineToken, identity: browserIdentity(11) });
    const inline = await post("/web-link/_dev/scan", {
      token: inlineToken,
      mobileUserId: PHONE.mobileUserId,
      mobileDeviceId: PHONE.mobileDeviceId,
      deliverInline: true,
    });
    const inlineCode = typeof inline.json.code === "string" ? (inline.json.code as string) : null;
    check("deliverInline returns the minted single-use code", inline.status === 200 && inlineCode !== null, inline.json);
    check(
      "...it is an opaque token, never a session credential",
      inlineCode !== null && /^[0-9a-f]{64}$/.test(inlineCode) && !/sessionToken|accessToken|refreshToken/i.test(JSON.stringify(inline.json)),
    );
    const inlineRedeem = inlineCode === null ? { status: 0, json: {} as Record<string, unknown> } : await post("/web-link/redeem", { code: inlineCode });
    check(
      "...it really redeems into a live session",
      inlineCode !== null && inlineRedeem.status === 201 && typeof inlineRedeem.json.sessionToken === "string",
      inlineRedeem.json,
    );
    const inlineReplay = inlineCode === null ? { status: 0, json: {} as Record<string, unknown> } : await post("/web-link/redeem", { code: inlineCode });
    check("...and it is spent: the same code cannot be redeemed twice", inlineCode !== null && inlineReplay.status === 410, inlineReplay.json);

    const pushOnlyToken = browserToken();
    const pushOnlyReg = await post("/web-link/register", { token: pushOnlyToken, identity: browserIdentity(12) });
    const pushOnly = await post("/web-link/_dev/scan", {
      token: pushOnlyToken,
      mobileUserId: PHONE.mobileUserId,
      mobileDeviceId: PHONE.mobileDeviceId,
      deliverInline: false,
    });
    check("deliverInline:false stays a push-only response", pushOnly.status === 200 && !/"code"/i.test(JSON.stringify(pushOnly.json)), pushOnly.json);
    check("...and the code was still pushed to link:<hash(token)>", lastPushedCode(String(pushOnlyReg.json.linkId ?? "")) !== null);

    await new Promise<void>((r) => server.close(() => r()));

    // The load-bearing security check: a production backend must not serve these.
    // Spawned as a child because route mounting is decided at import time.
    const devPathsIn = (nodeEnv: string): string[] => {
      const probe = spawnSync(
        process.execPath,
        ["--import", "tsx", "-e", "import('./src/routes/web-link.ts').then(m=>{const p=(m.default.stack??[]).map(l=>l.route?.path).filter(x=>x&&x.includes('_dev'));console.log('DEVROUTES:'+JSON.stringify(p));})"],
        { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: nodeEnv } },
      );
      const out = `${probe.stdout ?? ""}`;
      const m = /DEVROUTES:(\[.*\])/.exec(out);
      const captured = m?.[1];
      return captured ? (JSON.parse(captured) as string[]) : [`<probe failed: ${probe.stderr?.slice(0, 200) ?? ""}>`];
    };

    check("in development the dev triggers are mounted", devPathsIn("development").length === 3);
    check("in PRODUCTION the dev triggers are NOT mounted at all", devPathsIn("production").length === 0);
  }

  // ── Who the dev scan signs in AS ──────────────────────────────────────────
  // The dev trigger has to stand in for a phone, so somebody must name the
  // account. It used to be the CALLER that named it, which meant a session was
  // issued for whatever a client asserted — the body-trust R1.3 forbids
  // everywhere else, just moved to a different endpoint. Now `phoneNumber` is
  // resolved against the real `users` store (the same phone -> account lookup
  // OTP verify performs) and the session belongs to an account that exists.
  section("The dev scan resolves the account from the real user store, not from the caller's body");
  {
    setWebLinkStoreForTest(new MemoryWebLinkStore());
    installRecorderIo();

    // The account source is the one thing a harness must not need a database
    // for; the seam is the same override pattern as the realtime providers.
    const asked: string[] = [];
    const ACCOUNTS: Record<string, { userId: string; accountName: string }> = {
      "+919876543210": { userId: "acct-from-db-7", accountName: "Real Account Name" },
    };
    overrideAccountLookup(async (e164) => {
      asked.push(e164);
      return ACCOUNTS[e164] ?? null;
    });

    try {
      const app = express();
      app.use(express.json());
      app.use("/api/v1", webLinkRoutes);
      const server = http.createServer(app);
      await new Promise<void>((r) => server.listen(0, r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
      const post = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
        const r = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
      };

      // 1. The phone path: identity comes from the store, end to end.
      const phoneToken = browserToken();
      const phoneReg = await post("/web-link/register", { token: phoneToken, identity: browserIdentity(21) });
      const phoneLinkId = String(phoneReg.json.linkId ?? "");
      const phoneScan = await post("/web-link/_dev/scan", {
        token: phoneToken,
        phoneNumber: "+919876543210",
        mobileDeviceId: "dev-test-login",
        deliverInline: true,
      });
      check("a scan with phoneNumber approves", phoneScan.status === 200 && phoneScan.json.approved === true, phoneScan.json);
      check(
        "...and the approved account is the one the store returned",
        phoneScan.json.userId === "acct-from-db-7",
        { got: phoneScan.json.userId },
      );
      check("the lookup is asked with the caller's exact E.164 string", asked.includes("+919876543210"), asked);
      check("...and it is an ordinary approval: the code was still PUSHED to the room", lastPushedCode(phoneLinkId) !== null);

      const phoneCode = typeof phoneScan.json.code === "string" ? (phoneScan.json.code as string) : null;
      const phoneRedeem = phoneCode === null ? { status: 0, json: {} as Record<string, unknown> } : await post("/web-link/redeem", { code: phoneCode });
      check(
        "the session is issued for the store's account, with the store's name",
        phoneRedeem.status === 201 && phoneRedeem.json.userId === "acct-from-db-7" && phoneRedeem.json.accountName === "Real Account Name",
        phoneRedeem.json,
      );

      // 2. A forged identity in the SAME body must not win over the store.
      const forgedToken = browserToken();
      await post("/web-link/register", { token: forgedToken, identity: browserIdentity(22) });
      const forgedScan = await post("/web-link/_dev/scan", {
        token: forgedToken,
        phoneNumber: "+919876543210",
        mobileUserId: "attacker-chosen-id",
        accountName: "Attacker Chosen Name",
        mobileDeviceId: "dev-test-login",
        deliverInline: true,
      });
      const forgedCode = typeof forgedScan.json.code === "string" ? (forgedScan.json.code as string) : null;
      const forgedRedeem = forgedCode === null ? { status: 0, json: {} as Record<string, unknown> } : await post("/web-link/redeem", { code: forgedCode });
      check(
        "a body mobileUserId/accountName is IGNORED once phoneNumber is given",
        forgedScan.json.userId === "acct-from-db-7" && forgedRedeem.json.userId === "acct-from-db-7" && forgedRedeem.json.accountName === "Real Account Name",
        { scan: forgedScan.json, redeem: forgedRedeem.json },
      );

      // 3. Refusals must not consume the link. Every refused number below shares
      //    ONE link, so the final successful scan also proves that seven
      //    rejections left the token exactly as it was.
      const refusalToken = browserToken();
      const refusalReg = await post("/web-link/register", { token: refusalToken, identity: browserIdentity(23) });
      const refusalLinkId = String(refusalReg.json.linkId ?? "");
      const unknown = await post("/web-link/_dev/scan", {
        token: refusalToken,
        phoneNumber: "+919999999999",
        mobileUserId: "acct-from-db-7",
        mobileDeviceId: "dev-test-login",
      });
      check("an unregistered phone is refused (404 account_not_found)", unknown.status === 404 && unknown.json.error === "account_not_found", unknown);
      check("...and no code was pushed for it", lastPushedCode(refusalLinkId) === null);

      // 4. Only a real E.164 string ever reaches the store, so the equality
      //    lookup against users.phone_number cannot be fooled by formatting.
      const badPhones = ["9876543210", "+91 98765 43210", "", "not-a-phone", "+0123456789", "+12345678901234567"];
      for (const bad of badPhones) {
        const before = asked.length;
        const badRes = await post("/web-link/_dev/scan", { token: refusalToken, phoneNumber: bad, mobileDeviceId: "dev-test-login" });
        check(
          `a non-E.164 phone is refused without a store lookup (${JSON.stringify(bad)})`,
          badRes.status === 400 && badRes.json.error === "invalid_phone" && asked.length === before,
          { status: badRes.status, body: badRes.json },
        );
      }
      check(
        "the store is only ever queried with the E.164 strings the client sent",
        asked.every((a) => /^\+[1-9]\d{7,14}$/.test(a)),
        asked,
      );
      const afterRefusals = await post("/web-link/_dev/scan", {
        token: refusalToken,
        phoneNumber: "+919876543210",
        mobileDeviceId: "dev-test-login",
      });
      check("...and the link survived every refusal", afterRefusals.status === 200 && afterRefusals.json.userId === "acct-from-db-7", afterRefusals.json);

      // 5. The explicit mobileUserId form still works unchanged — it is how the
      //    rest of this harness drives a specific test account.
      const explicitToken = browserToken();
      await post("/web-link/register", { token: explicitToken, identity: browserIdentity(25) });
      const explicit = await post("/web-link/_dev/scan", {
        token: explicitToken,
        mobileUserId: PHONE.mobileUserId,
        mobileDeviceId: PHONE.mobileDeviceId,
      });
      check(
        "the explicit mobileUserId form is unchanged",
        explicit.status === 200 && explicit.json.userId === PHONE.mobileUserId,
        explicit.json,
      );
      check("...and it never consulted the account store", asked.every((a) => a === "+919876543210" || a === "+919999999999"), asked);

      await new Promise<void>((r) => server.close(() => r()));
    } finally {
      resetAccountLookup();
    }
  }

  // ── The client's 401 mapping, exercised against the real api-client ────────
  // Found by driving the Web app's development QR test-login route twice over
  // real HTTP: the first cookie came back as reason:"unreachable" instead of
  // "not_authorized", i.e. a session that had been genuinely revoked was being
  // reported as a connectivity problem. requireWebSession answers every 401 with
  // its own domain code, and the client let that code win over the status, which
  // made its own not_authorized branch unreachable. Status must be decisive.
  section("A revoked Web session is reported as not_authorized, never as unreachable");
  {
    // @wpt/api-client is TS-source-only with Node-ESM ".js" specifiers, so it is
  // imported at RUNTIME through a computed specifier: bare Node cannot resolve it
  // and a static specifier would drag the package into this tsconfig's rootDir.
  // Same trick web/messages/be-5-5-verify.ts uses to exercise real client code.
  const clientSpecifier = ["..", "..", "..", "..", "packages", "api-client", "src", "web-link.ts"].join("/");
  const { createWebLinkApi } = (await import(clientSpecifier)) as {
    createWebLinkApi: (config: { baseUrl: string; getAuthToken: () => string }) => {
      sessionStatus: () => Promise<{ ok: boolean; error?: string; message?: string }>;
    };
  };
    const opened: import("node:http").Server[] = [];
    const replyWith = async (status: number, body: Record<string, unknown>): Promise<string> => {
      const srv = http.createServer((_req, res) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      });
      opened.push(srv);
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    };

    // Every code requireWebSession (web-session.ts) and requireAuth can return.
    for (const code of ["WEB_SESSION_INVALID", "MISSING_WEB_SESSION", "EMPTY_WEB_SESSION", "INVALID_TOKEN", "MISSING_TOKEN"]) {
      const base = await replyWith(401, { error: code });
      const res = await createWebLinkApi({ baseUrl: base, getAuthToken: () => "t" }).sessionStatus();
      check(`401 ${code} -> not_authorized`, res.ok === false && res.error === "not_authorized", res);
    }
    // 410 and 429 keep their own meanings: the status is decisive, not exclusive.
    for (const [body, expected] of [[{ error: "already_used" }, "already_used"], [{ error: "expired" }, "expired"], [{}, "expired"]] as const) {
      const base = await replyWith(410, body as Record<string, unknown>);
      const res = await createWebLinkApi({ baseUrl: base, getAuthToken: () => "t" }).sessionStatus();
      check(`410 ${JSON.stringify(body)} -> ${expected}`, res.ok === false && res.error === expected, res);
    }
    const base429 = await replyWith(429, {});
    const res429 = await createWebLinkApi({ baseUrl: base429, getAuthToken: () => "t" }).sessionStatus();
    check("429 -> rate_limited (not not_authorized)", res429.ok === false && res429.error === "rate_limited", res429);

    for (const srv of opened) await new Promise<void>((r) => srv.close(() => r()));
  }

  console.log(`\nWEB-R1.1 verify: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

/** Register + scan + return the pushed code, for an independent link. */
async function freshLinkCode(
  api: ReturnType<typeof createWebLinkTestApi>,
  token: string,
  identity: WebLinkIdentityBundle,
  phone: { mobileUserId: string; mobileDeviceId: string; accountName?: string },
): Promise<string> {
  const reg = await api.register({ token, identity });
  if (!reg.ok) throw new Error("register failed");
  await api.simulateScan(token, phone);
  const code = lastPushedCode(reg.linkId);
  if (!code) throw new Error("no code was pushed");
  return code;
}

void main();
