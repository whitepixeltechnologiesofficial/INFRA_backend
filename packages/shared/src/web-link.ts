// WEB device-linking + Web-session contracts — Sprint 3.
//
// Single source of truth for the Web-linking protocol. The canonical sequence:
//
//   1. Web page loads.
//   2. Web checks its existing Web session (cookie-backed) — GET /web-session/status.
//   3. If authenticated → open the Web application. No QR, no token.
//   4. If not → the WEB generates an opaque linking token itself, using secure
//      browser cryptography (crypto.getRandomValues). Never Math.random, never
//      Date.now/UUID/counters, and never a phone number, userId or timestamp.
//   5. The Web generates an identity bundle (public key only) with
//      @wpt/crypto. The private key stays in page memory: never in the QR, in
//      a URL, in storage, in a log or in an error.
//   6. The Web REGISTERS the token + identity bundle with the backend and waits
//      for a success response. POST /web-link/register (anonymous, rate-limited).
//   7. ONLY NOW does the Web render the QR of `wpt://link/<token>` using the
//      npm `qrcode` package. The library renders pixels; it never mints tokens.
//   8. The Web holds a live connection (existing realtime namespace) joined to
//      `link:<hash(token)>` via a short-lived link ticket, so the backend can
//      PUSH the login hand-off. The Web does NOT poll "am I linked yet?".
//
//   9.  Phone scans the QR and the backend VALIDATES the token (mobile JWT).
//   10. Phone APPROVES (mobile JWT). The backend CLAIMS the link atomically
//       (registered → approved) and mints a single-use redemption code. It
//       creates no session and revokes nothing here: until the browser redeems
//       the code it holds a code, not authority (R1.6 — the one-browser
//       transaction is at step 12, NOT here).
//   11. The backend PUSHES {code} to the linked browser over the existing live
//       connection (event `webLinkLogin`, re-emitted on reconnect).
//   12. The browser exchanges the code at POST /web-link/redeem, server-to-
//       server from the BFF. This is where the ONE-BROWSER TRANSACTION runs
//       (R1.6): in ONE indivisible store call, at exactly the instant authority
//       transfers, the backend revokes every prior Web session for the account
//       and creates the new one. Only this hop ever sees the Web session
//       credential; the browser receives an HttpOnly cookie and display
//       identity only.
//   13. The Web opens chats. The phone session is untouched by any of this.
//
// Authority split (deliberate, and the reason the flow above is not negotiable):
//   - the BROWSER owns the token's *randomness* (secure browser CSPRNG);
//   - the BACKEND owns the token's *existence, age, expiry, used-state and
//     authorization* — it stores only SHA-256(token), never the raw token.
//
// The QR carries the opaque token and nothing else. The identity bundle is
// bound server-side to SHA-256(token) at registration, so no public key, and
// above all no private key, ever travels through the camera.
//
// NOTE: this module is deliberately self-contained and uses only erasable
// TypeScript syntax (no enums / runtime type syntax) so Node's native type
// stripping can import it directly in verification harnesses.

// QR token lifetime — exactly 60 seconds (R1.2). The backend enforces this;
// the Web countdown is cosmetic. (R1.3 is the authentication requirement on
// validate/approve — see apps/backend/src/web-link/service.ts for the authority
// list this contract implements.)
export const WEB_LINK_TTL_MS = 60_000;

// Persistent Web session lifetime: 90 days. After this the session is expired
// server-side and the browser must re-link. (This lifetime is NOT R1.7. R1.7 is
// the enumeration SCOPE invariant: linking enumerates WEB sessions only, so a
// phone session is never touched and linking a browser can never log the phone
// out. See apps/backend/src/web-link/service.ts for the authority list.)
export const WEB_SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// Short-lived realtime ticket: 60 seconds (single-use expiry, refreshed on
// reconnect). Never a long-lived credential and never in a URL.
export const WEB_REALTIME_TICKET_MS = 60_000;

// The link ticket authorises exactly ONE thing: joining the room for one
// specific registered token, so the backend can push the login hand-off to that
// browser and nobody else. 60s, aud-restricted, and it carries the token HASH —
// never the token.
export const WEB_LINK_TICKET_MS = 60_000;

// Redemption code: what the backend PUSHES. It is not a session credential; it
// is a single-use, 60s bearer that the BFF exchanges for the Web session
// server-to-server. This is what keeps the long-lived credential out of the
// browser's JavaScript heap.
export const WEB_LINK_REDEEM_TTL_MS = 60_000;

// Identity bundle wire version. Bumped only on a breaking key-format change.
export const WEB_LINK_IDENTITY_VERSION = 1;

// Opaque linking-reference format carried by the QR. The token is a
// backend-issued random value — it is NOT a credential, contains no
// identity/phone/OTP/key material, and is single-use.
export const WEB_LINK_SCHEME = "wpt";
export const WEB_LINK_QR_PREFIX = `${WEB_LINK_SCHEME}://link/`;

export type WebLinkErrorCode =
  | "expired"
  | "invalid"
  | "already_used"
  | "not_approved"
  | "not_registered"
  | "not_authorized"
  | "rate_limited";

export const WEB_LINK_ERROR_MESSAGES: Record<WebLinkErrorCode, string> = {
  expired: "This QR code has expired. Please scan the new QR code.",
  invalid: "This QR code is invalid.",
  already_used: "This QR code has already been used.",
  not_approved: "This QR code has not been approved on your phone yet.",
  not_registered: "This browser did not register this code. Please refresh the page.",
  not_authorized: "You are not authorized to perform this action.",
  rate_limited: "Too many requests. Please try again later.",
};

/**
 * The PUBLIC half of a Web identity. This is the complete set of fields the
 * backend ever receives about a browser's key material: a base64url ed25519
 * public key plus when it was minted. There is deliberately no private-key
 * field — it is not representable here, so it cannot be logged or serialized
 * by accident.
 */
export interface WebLinkIdentityBundle {
  version: number;
  /** base64url ed25519 public key (32 bytes decoded). */
  publicKey: string;
  /** ISO timestamp — provenance only, never used as a token. */
  createdAt: string;
}

/** Shape guard for a client-supplied identity bundle (never trust the wire). */
export function isWebLinkIdentityBundle(value: unknown): value is WebLinkIdentityBundle {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Record<string, unknown>;
  if (b.version !== WEB_LINK_IDENTITY_VERSION) return false;
  if (typeof b.publicKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(b.publicKey)) return false;
  if (typeof b.createdAt !== "string" || Number.isNaN(Date.parse(b.createdAt))) return false;
  return true;
}

// The opaque token contract: 32 CSPRNG bytes rendered as 64 lowercase hex
// chars. Shared by the browser's generator, the backend's store and the mobile
// QR parser so the three can never disagree about what a token looks like.
export const WEB_LINK_TOKEN_HEX_LENGTH = 64;

export function isWebLinkToken(value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${WEB_LINK_TOKEN_HEX_LENGTH}}$`).test(value);
}

/** POST /web-link/register request — the browser's own token + public identity. */
export interface WebLinkRegisterRequest {
  token: string;
  identity: WebLinkIdentityBundle;
}

/**
 * POST /web-link/register response. `linkTicket` is what the browser presents
 * to the realtime namespace to join its own `link:` room. The QR is rendered
 * only after this arrives.
 */
export interface WebLinkRegisterResult {
  ok: true;
  /** SHA-256(token) — safe to log, and the link's primary key. */
  linkId: string;
  /** The exact payload to render as a QR: `wpt://link/<token>`. */
  qrPayload: string;
  /** ISO expiry; the backend rejects the token at or after this instant. */
  expiresAt: string;
  ttlMs: number;
  linkTicket: string;
}

/**
 * POST /web-link/redeem response. Consumed by the BFF only: `sessionToken` must
 * be written straight into an HttpOnly cookie and must never be relayed to
 * browser JavaScript, localStorage, a URL or a log line.
 */
export interface WebLinkRedeemResult {
  ok: true;
  sessionToken: string;
  userId: string;
  deviceId: string;
  webSessionId: string;
  accountName: string;
  expiresAt: string;
}

export interface WebLinkFailureResult {
  ok: false;
  error: WebLinkErrorCode;
  message: string;
}

export interface WebLinkValidateResult {
  ok: true;
  valid: true;
  /** Account display name (the authenticated mobile user's own account). */
  accountName: string;
  expiresAt: string;
}

export interface WebLinkApproveResult {
  ok: true;
  approved: true;
}

export interface WebSessionStatusResult {
  ok: true;
  userId: string;
  deviceId: string;
  webSessionId: string;
  /** ISO server-side expiry. */
  expiresAt: string;
}

/**
 * Server → Web push events over the existing realtime namespace.
 *
 * `webLinkLogin` is the mechanism that removes polling from the linking flow
 * entirely: the backend pushes it the instant the phone approves (and re-emits
 * it on reconnect while the code is unspent), and the browser's only remaining
 * job is the redeem call. `webForceLoggedOut` is the pre-existing session
 * cutoff notice and is unchanged by this flow.
 */
export const WEB_LINK_EVENTS = {
  login: "webLinkLogin",
  approved: "webLinkApproved",
  forceLoggedOut: "webForceLoggedOut",
} as const;

/** Payload pushed on `webLinkLogin`. Carries a code, never a credential. */
export interface WebLinkLoginPush {
  /** Single-use redemption code. BFF exchanges it for the session server-side. */
  code: string;
  /** ISO expiry of the code itself. */
  expiresAt: string;
  /** ISO expiry of the link, for the countdown's final frame. */
  linkExpiresAt: string;
}

/** Socket room for one registered token. Keyed by SHA-256(token). */
export function webLinkRoom(linkId: string): string {
  return `link:${linkId}`;
}

export interface LinkedWebDevice {
  deviceId: string;
  linkedAt: string;
  lastSeenAt?: string;
  /**
   * Set ONLY when a revocation actually happened (R1.8 logout, the mobile device
   * revoke, R1.6 browser replacement, R1.9 new-phone force logout).
   *
   * This is a revocation FACT, never an expiry marker. A session that simply
   * aged past the 90-day maximum still reports `revokedAt: undefined`, because
   * no revocation occurred — see the REVOCATION-AUTHORITY CONTRACT in
   * `apps/backend/src/web-link/store.ts` for why a backend MUST NOT backfill it
   * for expiry, which would make an aged-out session indistinguishable from one
   * the user deliberately logged out of. Expiry is not reportable in this shape:
   * usability stays server-side, decided by `isWebSessionActive` on every
   * request.
   */
  revokedAt?: string;
  /**
   * True for the device THIS request was made from (when known).
   *
   * Request-scoped, and deliberately NOT populated by `GET /web-link/devices`:
   * that route is authenticated with the MOBILE JWT, so "this request" is the
   * phone's own session — a phone device, never a Web device — and filling it
   * in would either label a row that is not in this list or have to come from
   * the client, which is the one thing R1.8 forbids. Nothing in the product
   * populates or reads it today; it is optional, so its absence is not a
   * contract violation, and no consumer may infer "current" from its absence.
   */
  current?: boolean;
}

export type WebLinkApiResult<T> =
  | T
  | WebLinkFailureResult;

// Canonical route paths (mounted under /api/<API_VERSION> and proxied by the
// Next.js BFF at /api/...).
export const WEB_LINK_API = {
  register: () => "/web-link/register",
  validate: (token: string) => `/web-link/${encodeURIComponent(token)}/validate`,
  approve: (token: string) => `/web-link/${encodeURIComponent(token)}/approve`,
  redeem: () => "/web-link/redeem",
  sessionStatus: () => "/web-session/status",
  sessionLogout: () => "/web-session/logout",
  sessionTicket: () => "/web-session/ticket",
  listDevices: () => "/web-link/devices",
  revokeDevice: (deviceId: string) => `/web-link/devices/${encodeURIComponent(deviceId)}`,
} as const;

/** The QR payload for a token. The token is the only thing in it. */
export function webLinkQrPayload(token: string): string {
  return `${WEB_LINK_QR_PREFIX}${token}`;
}

/** Parse the expected QR payload: `wpt://link/<token>` + `<scheme>:<rest>`. */
export function parseWebLinkQrPayload(value: string): string | null {
  const raw = (value ?? "").trim();
  if (!raw.startsWith(WEB_LINK_QR_PREFIX)) return null;
  const token = raw.slice(WEB_LINK_QR_PREFIX.length).trim();
  if (!token || token.length === 0) return null;
  // Opaque token contract: hex only (32 random bytes → 64 hex chars).
  if (!isWebLinkToken(token)) return null;
  return token;
}