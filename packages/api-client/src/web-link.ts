// Web-linking + Web-session API surface for BOTH clients (web + mobile).
//
// Centralized in @wpt/api-client so neither app ever scatters raw fetch() calls
// against the linking/session contract (Sprint 3 R7.7). The same object is
// used by:
//   - the Next.js server-side route handlers (getAuthToken reads the HttpOnly
//     cookie value server-side) and
//   - the Mobile app (getAuthToken reads the SecureStore access token).
//
// This module is the ONLY place the Web/Mobile learn the web-link wire format,
// which is what makes the mock ⇄ real-backend switch purely a matter of
// `baseUrl` (i.e. API_BASE_URL). No screen ever branches on "mock vs real".
//
// All endpoints are backend-authoritative; nothing here trusts a client-passed
// userId for authorization.

import { createHttpClient, type ApiClientConfig, HttpError } from "./http.js";
import { WEB_LINK_API, WEB_LINK_ERROR_MESSAGES } from "@wpt/shared";
import type {
  LinkedWebDevice,
  WebLinkApiResult,
  WebLinkApproveResult,
  WebLinkFailureResult,
  WebLinkIdentityBundle,
  WebLinkRedeemResult,
  WebLinkRegisterResult,
  WebLinkValidateResult,
  WebSessionStatusResult,
} from "@wpt/shared";

export interface WebLinkSessionTicketResult {
  ok: true;
  ticket: string;
}

export interface WebLinkDevicesResult {
  ok: true;
  devices: LinkedWebDevice[];
}

export interface WebLinkLogoutResult {
  ok: true;
}

/**
 * Result of the dev-only `simulateScan` trigger. Note what is ABSENT: no access
 * token, no refresh token, no session credential of any kind. The scan's only
 * effect is that the backend mints a single-use redemption code and PUSHES it to
 * `link:<hash(token)>`; the credential is created later, server-to-server, by
 * `redeem`, and only ever reaches the browser as an HttpOnly cookie.
 */
export interface WebLinkDevScanResult {
  ok: true;
  approved: true;
  userId: string;
  webDeviceId: string;
  /**
   * Present ONLY when the caller explicitly asked for `deliverInline: true`.
   *
   * It is the same single-use 60s code the PUSH carries — not a session
   * credential, and still exchanged server-to-server by `redeem`. It exists so a
   * headless dev client with no socket in the room can finish the protocol; the
   * default response remains free of it, so the "a scan response carries no
   * credential" invariant still holds for every other caller.
   */
  code?: string;
  codeExpiresAt?: string;
  linkExpiresAt?: string;
}

export interface WebLinkDevForceLogoutResult {
  ok: true;
  revokedCount: number;
}

export interface WebLinkDevPhonePresenceResult {
  ok: true;
  userId: string;
  online: boolean;
  /** Always false: phone reachability must never affect a Web session (R1.4). */
  sessionAffected: false;
}

/** Dev-only trigger paths. These are NOT protocol and BE-6.1 need not implement them. */
export const WEB_LINK_DEV_API = {
  scan: () => "/web-link/_dev/scan",
  forceLogout: () => "/web-link/_dev/force-logout",
  phonePresence: () => "/web-link/_dev/phone-presence",
} as const;

export type WebLinkErrorCode = WebLinkFailureResult["error"];

/** Small helper: coerce an api result into a human-safe error message. */
export function webLinkErrorMessage(result: WebLinkApiResult<unknown> | null): string {
  if (!result) return "Unable to connect. Please try again.";
  if (typeof result === "object" && result !== null && "ok" in result && result.ok === false) {
    return "message" in result && typeof result.message === "string"
      ? result.message
      : "This request could not be completed.";
  }
  return "Unexpected response from the server.";
}

export function createWebLinkApi(config: ApiClientConfig) {
  const http = createHttpClient(config);

  async function unwrap<T>(promise: Promise<T>): Promise<WebLinkApiResult<T>> {
    try {
      return (await promise) as T;
    } catch (err) {
      if (err instanceof HttpError) {
        const status = (err as HttpError).status;
        const body = (err as HttpError).body;
        const readBody = (): { error?: string; message?: string } =>
          body && typeof body === "object" ? (body as { error?: string; message?: string }) : {};

        // 401 is decided by the STATUS, before any body code is considered. Every
        // authenticated surface in this backend answers 401 with its own
        // domain code - WEB_SESSION_INVALID, MISSING_WEB_SESSION,
        // EMPTY_WEB_SESSION, INVALID_TOKEN - and letting that code win meant
        // `not_authorized` was effectively unreachable: a revoked or replaced Web
        // session was reported as a generic failure, so the BFF told the client
        // the service was "unreachable" when it had actually been signed out.
        // A 401 always means exactly one thing: this credential is no longer
        // accepted. The body's message is kept for display.
        if (status === 401) {
          const b = readBody();
          return {
            ok: false,
            error: "not_authorized",
            message: typeof b.message === "string" ? b.message : "Your session is no longer valid.",
          } satisfies WebLinkFailureResult;
        }
        if (status === 410) {
          const b = readBody();
          const code410: WebLinkErrorCode =
            b.error === "expired" || b.error === "already_used" || b.error === "not_approved" ? b.error : "expired";
          return {
            ok: false,
            error: code410,
            message: typeof b.message === "string" ? b.message : "This link is no longer available.",
          } satisfies WebLinkFailureResult;
        }
        if (status === 429) {
          return { ok: false, error: "rate_limited", message: "Too many requests. Please try again later." } satisfies WebLinkFailureResult;
        }
        if (body && typeof body === "object") {
          const b = readBody();
          const code: WebLinkErrorCode = (b.error as WebLinkErrorCode) || "invalid";
          if (typeof b.error === "string") {
            // The CODE is for the program; the MESSAGE is for the person looking
            // at the screen. Falling back to the code here is how a bare
            // "register_failed" ended up rendered as user-facing copy, so the
            // fallback is now the shared human message for that code (or a
            // neutral one for a code the contract does not name).
            const fallback = WEB_LINK_ERROR_MESSAGES[code] ?? "This request could not be completed. Please try again.";
            return {
              ok: false,
              error: code,
              message: typeof b.message === "string" && b.message ? b.message : fallback,
            } satisfies WebLinkFailureResult;
          }
        }
      }
      return { ok: false, error: "invalid", message: "Unable to connect. Please try again." } satisfies WebLinkFailureResult;
    }
  }

  return {
    /**
     * POST /web-link/register — the browser registers the token IT generated
     * (crypto.getRandomValues) together with its PUBLIC identity bundle. The
     * caller must not render a QR until this resolves ok:true.
     */
    register(input: {
      token: string;
      identity: WebLinkIdentityBundle;
    }): Promise<WebLinkApiResult<WebLinkRegisterResult>> {
      return unwrap(
        http.post<WebLinkApiResult<WebLinkRegisterResult>>(WEB_LINK_API.register(), input),
      );
    },

    /** GET /web-link/:token/validate — mobile (authenticated) pre-approval check. */
    validateLink(token: string): Promise<WebLinkApiResult<WebLinkValidateResult>> {
      return unwrap(http.get<WebLinkApiResult<WebLinkValidateResult>>(WEB_LINK_API.validate(token)));
    },

    /** POST /web-link/:token/approve — mobile (authenticated) authorizes linking. */
    approveLink(token: string): Promise<WebLinkApiResult<WebLinkApproveResult>> {
      return unwrap(http.post<WebLinkApiResult<WebLinkApproveResult>>(WEB_LINK_API.approve(token), {}));
    },

    /**
     * POST /web-link/redeem — spend the server-PUSHED code for a Web session.
     * Server-to-server only: the returned `sessionToken` must go straight into
     * an HttpOnly cookie and must never reach browser JavaScript.
     */
    redeemLink(code: string): Promise<WebLinkApiResult<WebLinkRedeemResult>> {
      return unwrap(
        http.post<WebLinkApiResult<WebLinkRedeemResult>>(WEB_LINK_API.redeem(), { code }),
      );
    },

    /** GET /web-session/status — validates the Web session server-side. */
    sessionStatus(): Promise<WebLinkApiResult<WebSessionStatusResult>> {
      return unwrap(http.get<WebLinkApiResult<WebSessionStatusResult>>(WEB_LINK_API.sessionStatus()));
    },

    /** POST /web-session/logout — server-side revocation of the Web session. */
    logoutSession(): Promise<WebLinkApiResult<WebLinkLogoutResult>> {
      return unwrap(http.post<WebLinkApiResult<WebLinkLogoutResult>>(WEB_LINK_API.sessionLogout(), {}));
    },

    /** POST /web-session/ticket — short-lived realtime socket credential. */
    sessionTicket(): Promise<WebLinkApiResult<WebLinkSessionTicketResult>> {
      return unwrap(http.post<WebLinkApiResult<WebLinkSessionTicketResult>>(WEB_LINK_API.sessionTicket(), {}));
    },

    /** GET /web-link/devices — list the user's linked Web devices (mobile). */
    listDevices(): Promise<WebLinkApiResult<WebLinkDevicesResult>> {
      return unwrap(http.get<WebLinkApiResult<WebLinkDevicesResult>>(WEB_LINK_API.listDevices()));
    },

    /** DELETE /web-link/devices/:id — revoke a linked Web device (mobile). */
    revokeDevice(deviceId: string): Promise<WebLinkApiResult<WebLinkLogoutResult>> {
      return unwrap(http.del<WebLinkApiResult<WebLinkLogoutResult>>(WEB_LINK_API.revokeDevice(deviceId)));
    },

    /**
     * WEB-R1.1 dev/test triggers. These exist so the Web linking funnel can be
     * driven end to end WITHOUT a physical phone, and they are served only when
     * the backend runs with NODE_ENV !== "production" (they 404 otherwise).
     *
     * They are deliberately NOT part of the shared protocol contract: no screen,
     * no package and BE-6.1 depends on them. Switching API_BASE_URL from a dev
     * backend to the real BE-6.1 needs no change here — the calls simply stop
     * being made.
     */
    dev: {
      /**
       * Simulate "phone scans the QR and approves". Returns the approve result
       * with NO credential; the redemption code arrives as a server PUSH on
       * `link:<hash(token)>`, which is what keeps this push-based rather than
       * request/response authentication.
       *
* `deliverInline: true` is for a caller with no socket in the room to
       * receive that push on. It returns the same single-use code in the
       * response body instead?" a server-to-server convenience for headless dev
       * tooling, not a different authentication path, and never a session
       * credential.
       *
       * IDENTITY: pass `phoneNumber` (E.164) and the backend resolves the account
       * from its own user store, ignoring any `mobileUserId`/`accountName` in the
       * same request. That is how a client learns who it is instead of asserting
       * it. `mobileUserId` remains for callers that deliberately drive a
       * specific test account.
       */
      simulateScan(input: {
        token: string;
        mobileUserId?: string;
        mobileDeviceId: string;
        phoneNumber?: string;
        accountName?: string;
        deliverInline?: boolean;
      }): Promise<WebLinkApiResult<WebLinkDevScanResult>> {
        return unwrap(http.post<WebLinkApiResult<WebLinkDevScanResult>>(WEB_LINK_DEV_API.scan(), input));
      },

      /** Simulate a new-phone login: revoke every Web session and push force_logout. */
      simulateForceLogout(input: { userId: string; reason?: string }): Promise<WebLinkApiResult<WebLinkDevForceLogoutResult>> {
        return unwrap(http.post<WebLinkApiResult<WebLinkDevForceLogoutResult>>(WEB_LINK_DEV_API.forceLogout(), input));
      },

      /**
       * Simulate the phone going offline / coming back. Affects no session: a
       * Web session must survive a phone that is merely unreachable (R1.4).
       */
      simulatePhonePresence(input: { userId: string; online: boolean }): Promise<WebLinkApiResult<WebLinkDevPhonePresenceResult>> {
        return unwrap(http.post<WebLinkApiResult<WebLinkDevPhonePresenceResult>>(WEB_LINK_DEV_API.phonePresence(), input));
      },
    },
  };
}

export type WebLinkApi = ReturnType<typeof createWebLinkApi>;