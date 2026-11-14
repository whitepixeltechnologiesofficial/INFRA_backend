// WEB-R1.1 — named trigger API for the web-linking lifecycle.
//
// WHY THIS EXISTS
// The web-linking protocol is NOT a mock and never was: it is the real backend
// authority in ./service.ts, behind the createWebLinkApi seam in
// @wpt/api-client, and it is already proven by web-link-verify.ts (136 checks).
// What a developer (or a harness) was missing is a *named* way to drive it
// without a physical phone, so that Team Alpha can exercise the whole Web
// linking funnel (and WEB-R1.4/R1.5 session survival) before BE-6.1 lands.
//
// So this file adds NAMES, not behaviour. Every method below is a one-line
// delegation to an existing service function:
//
//   register           -> service.register
//   simulateScan       -> service.approve      (the phone approving IS the scan)
//   validate           -> service.validate     (the phone's pre-approval check)
//   redeem             -> service.redeem
//   sessionStatus      -> service.sessionStatus
//   logout             -> service.logout
//   simulateForceLogout-> service.revokeUserWebSessions
//   simulatePhoneOffline/Online -> a caller-supplied transport (see below)
//
// There is deliberately NO second state machine, NO second store and NO second
// implementation: if this file ever needs a branch the service does not have,
// the change belongs in ./service.ts, not here.
//
// ── The push contract is preserved ────────────────────────────────────────────
// `simulateScan` does NOT return credentials. The scan trigger's job is to make
// the backend mint a single-use redemption code and PUSH it to the link room
// (`link:<sha256(token)>`) over the existing realtime namespace. A harness
// proves delivery by recording what the real socket registry emitted. Returning
// { accessToken, refreshToken } from this call would model request/response
// authentication and break R1.5, so the return type is the approve result,
// which contains no secret at all. The long-lived session credential is created
// later, server-to-server, by `redeem` and only ever lands in an HttpOnly cookie.
//
// ── Time ─────────────────────────────────────────────────────────────────────
// TTL behaviour (60s) is verified by ADVANCING a clock, never by sleeping 60
// seconds. The service already accepts an injected `now` on every call; this
// facade simply owns the default and lets a test move it.

import type { WebLinkIdentityBundle } from "@wpt/shared";
import { getWebLinkService, type WebLinkService } from "./service.js";

/** Phone reachability. Owned by the chat relay in production — see the note on
 *  `phonePresence` below — so this module models the state, not the transport. */
export type PhonePresenceState = "online" | "offline";

/** A clock a test can move. `now()` is injected into every service call. */
export interface WebLinkTestClock {
  now(): Date;
  /** Move the clock forward and return the new instant. */
  advance(ms: number): Date;
}

/** A clock frozen at `start` (defaults to the wall clock). */
export function createWebLinkTestClock(start: Date = new Date()): WebLinkTestClock {
  let current = start.getTime();
  return {
    now(): Date {
      return new Date(current);
    },
    advance(ms: number): Date {
      current += ms;
      return new Date(current);
    },
  };
}

/** Why a phone-presence change was requested, for the caller's own transport. */
export interface PhonePresenceChange {
  userId: string;
  state: PhonePresenceState;
  at: Date;
}

export interface WebLinkTestApiOptions {
  /** Defaults to the app-wide service (the real backend authority). */
  service?: WebLinkService;
  /** Defaults to a clock frozen at the wall clock. */
  clock?: WebLinkTestClock;
  /**
   * Where a phone going offline/online is actually announced.
   *
   * In production that is the CHAT relay's existing `mockPhoneStatus` push on
   * `user:<userId>` (apps/web/server/wpt-server.mjs, /api/mock/phone-*), which
   * WEB-R1.4/R1.5 already consume. This module deliberately does NOT invent a
   * second presence protocol for the linking channel — §11 of WEB-R1.1 asks for
   * the existing event, so a harness injects the transport it already has.
   */
  phonePresence?: (change: PhonePresenceChange) => void | Promise<void>;
}

export interface ScanIdentity {
  /** The authenticating phone's userId (from its JWT, never from a body field). */
  mobileUserId: string;
  mobileDeviceId: string;
  accountName?: string;
}

export function createWebLinkTestApi(options: WebLinkTestApiOptions = {}) {
  const service = options.service ?? getWebLinkService();
  const clock = options.clock ?? createWebLinkTestClock();
  const phonePresence = options.phonePresence;

  async function announce(userId: string, state: PhonePresenceState): Promise<PhonePresenceChange> {
    const change: PhonePresenceChange = { userId, state, at: clock.now() };
    await phonePresence?.(change);
    return change;
  }

  return {
    /** Exposed so a harness can read "now" without importing its own clock. */
    clock,

    /**
     * R1.1 — the browser registers the token IT generated (CSPRNG) plus its
     * PUBLIC identity. The backend is the authority on existence/age/used-state.
     */
    register(input: { token: string; identity: WebLinkIdentityBundle }) {
      return service.register({ token: input.token, identity: input.identity, now: clock.now() });
    },

    /**
     * The simulated phone scan.
     *
     * Returns the APPROVE result (ok/approved/userId/webDeviceId) — never a
     * credential. The redemption code is minted server-side and PUSHED to
     * `link:<hash(token)>`; read it from the socket emission, then spend it with
     * `redeem`. Passing `at` lets a test simulate a scan that lands after the
     * 60s window, which must come back as a typed `expired`.
     */
    simulateScan(token: string, identity: ScanIdentity, at?: Date) {
      return service.approve(
        token,
        {
          mobileUserId: identity.mobileUserId,
          mobileDeviceId: identity.mobileDeviceId,
          accountName: identity.accountName,
        },
        at ?? clock.now(),
      );
    },

    /**
     * The phone-side pre-check: "is this QR still usable?" (R1.3, and the TTL
     * half of R1.2). Purely a read — it never advances the link's state, so
     * calling it does not consume the token.
     */
    validate(token: string, at?: Date) {
      return service.validate(token, at ?? clock.now());
    },

    /** Spend a PUSHED code for a Web session. Server-to-server in production. */
    redeem(code: string, at?: Date) {
      return service.redeem(code, at ?? clock.now());
    },

    /** Validate a session credential server-side (R1.7). */
    sessionStatus(sessionToken: string, at?: Date) {
      return service.sessionStatus(sessionToken, at ?? clock.now());
    },

    /** R1.8 — server-side revocation. The credential dies immediately. */
    logout(sessionToken: string, at?: Date) {
      return service.logout(sessionToken, at ?? clock.now());
    },

    /**
     * R1.9 — a new phone signed in. Revokes every WEB session for the account and
     * PUSHES `webForceLoggedOut` to each. Scoped to web sessions by
     * construction, so the phone that just logged in is never touched.
     */
    simulateForceLogout(userId: string, reason = "new_phone_login", at?: Date) {
      return service.revokeUserWebSessions(userId, reason, at ?? clock.now());
    },

    /**
     * The phone went offline. Asserts nothing about the Web session: the
     * session is deliberately left untouched (R1.4), and a Web operation must
     * still succeed. Only the presence transport is notified.
     */
    simulatePhoneOffline(userId: string) {
      return announce(userId, "offline");
    },

    /** The phone came back. Same contract as offline, in the other direction. */
    simulatePhoneOnline(userId: string) {
      return announce(userId, "online");
    },
  };
}

export type WebLinkTestApi = ReturnType<typeof createWebLinkTestApi>;
