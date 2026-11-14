// Web-link core state machine — pure, DB-free, Node-verifiable.
//
// Model: two record types, plus pure transition functions. The store behind
// them is swapped for tests (memory) vs. production (see store.ts), but the
// invariants live here and are exercised by the harness regardless of storage.

import {
  WEB_LINK_IDENTITY_VERSION,
  WEB_LINK_REDEEM_TTL_MS,
  WEB_LINK_TTL_MS,
  WEB_SESSION_MAX_AGE_MS,
  isWebLinkIdentityBundle,
  isWebLinkToken,
  type WebLinkIdentityBundle,
} from "@wpt/shared";
import { secureHash } from "./crypto.js";

/**
 * registered → the browser has registered this token + its public identity
 *             (this is the state the QR is allowed to be shown in)
 * approved  → the authenticated phone approved; the session exists and a
 *             single-use redemption code has been minted and pushed
 * claimed   → the redemption code was spent; the token is permanently dead
 */
export type WebLinkStatus = "registered" | "approved" | "claimed";

export interface WebLinkRecord {
  /** SHA-256(token) — the primary key. Raw token never retained. */
  tokenHash: string;
  /** ISO expiry (registration time + WEB_LINK_TTL_MS). */
  expiresAt: string;
  status: WebLinkStatus;
  /**
   * The browser's PUBLIC identity, supplied at registration. Public key only —
   * there is no private key in the system, on the wire or in this record.
   */
  identity: WebLinkIdentityBundle;
  /** Stable per-browser id derived from the identity's public key. */
  webDeviceId: string;
  /** Mobile userId that approved this link (set at approve time). */
  approvedByUserId?: string;
  /** Mobile deviceId that approved this link (set at approve time). */
  approvedByDeviceId?: string;
  /** Account display name captured at approve time. */
  accountName?: string;
  /** webSessionId created at approve time (single-use enforcement). */
  claimedSessionId?: string;
  /**
   * SHA-256 of the single-use redemption code that was pushed to the browser.
   * The raw code is never stored, so a leaked row cannot be redeemed.
   */
  redeemCodeHash?: string;
  /** ISO expiry of the redemption code. */
  redeemExpiresAt?: string;
  /**
   * R1.5 — when the CURRENT redemption code was committed to a PUSH, i.e. a
   * link socket was in the room at the moment the code was minted. Set in the
   * SAME atomic claim that mints the code, so "this code was handed to a browser"
   * is part of the write that created it and not a later observation.
   *
   * Its presence is a promise the backend must keep: a code that was pushed can
   * no longer be superseded by the reconnect re-issue, because the browser is
   * holding it and there is no polling to recover from being handed a dead one
   * (which is the whole point of R1.5). See `canReissueRedeemCode` and
   * `WebLinkStore.rotateRedeemCode`, which enforces it atomically.
   *
   * Absent = the code was minted but delivered nowhere, so superseding it is
   * free — that is exactly the lost-push case the re-issue exists to recover.
   */
  redeemPushedAt?: string;
  createdAt: string;
}

export interface WebSessionRecord {
  /** UUID. */
  id: string;
  userId: string;
  /** Stable per-browser id (derived from the registered public identity). */
  deviceId: string;
  /** The browser's public key this session is bound to. */
  publicKey: string;
  /** SHA-256(sessionToken) — raw session token never stored. */
  tokenHash: string;
  accountName: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastSeenAt?: string;
}

export function isWebLinkExpired(link: WebLinkRecord, now: Date): boolean {
  return new Date(link.expiresAt).getTime() <= now.getTime();
}

export function isWebSessionActive(session: WebSessionRecord, now: Date): boolean {
  if (session.revokedAt) return false;
  return new Date(session.expiresAt).getTime() > now.getTime();
}

/** A redemption code is spendable only while unspent and inside its own TTL. */
export function isRedeemCodeLive(link: WebLinkRecord, now: Date): boolean {
  if (link.status !== "approved" || !link.redeemCodeHash) return false;
  if (new Date(link.redeemExpiresAt ?? 0).getTime() <= now.getTime()) return false;
  return new Date(link.expiresAt).getTime() > now.getTime();
}

/** The token may be shown as a QR only once the browser has registered it. */
export function isWebLinkRegistered(link: WebLinkRecord): boolean {
  return link.status === "registered";
}

/**
 * R1.2 (single-use) — may THIS token hash be registered again?
 *
 * A token is a bearer secret that was displayed in a camera-visible QR, so
 * "expired" is NOT the same as "safe to reuse". The rule is deliberately about
 * what the token was used FOR, not about how much time has passed:
 *
 *   - `approved` / `claimed` → PERMANENTLY DEAD. The token has already been
 *     spent authorising a link, and a redemption code was minted and PUSHED to
 *     `link:<hash(token)>`. Browser sockets are never removed from that room
 *     when the token expires, so re-registering the hash would let anybody who
 *     saw the QR re-approve it and have the new code delivered into the ORIGINAL
 *     browser's still-open room — a cross-account hand-off. It would also drop
 *     the legitimate record, making the victim's own pending code unredeemable.
 *     So a used token can never come back, however long ago it was used.
 *
 *   - `registered` and still live → refuse. The QR is on screen right now.
 *
 *   - `registered` and expired → admit. This is the only real retry: the browser
 *     never obtained an approval, nothing was ever pushed, and a token that was
 *     never used is not "used" by being shown.
 */
export function canReregisterToken(link: WebLinkRecord, now: Date): boolean {
  if (link.status === "approved" || link.status === "claimed") return false;
  return isWebLinkExpired(link, now);
}

/**
 * Stable per-browser id. Derived from the PUBLIC key only, so the same browser
 * identity maps to the same device row across re-links without the backend ever
 * needing — or storing — a private key.
 */
export function webDeviceIdFor(identity: WebLinkIdentityBundle): string {
  return `web_${secureHash(identity.publicKey).slice(0, 32)}`;
}

/**
 * Pure registration validator. The backend never trusts a client-supplied
 * token's shape, expiry or identity — this only decides whether the record is
 * admissible; age/used-state are decided against stored state afterwards.
 */
export function validateRegistration(
  input: { token?: unknown; identity?: unknown },
):
  | { ok: true; token: string; identity: WebLinkIdentityBundle }
  | { ok: false; error: "invalid"; message: string } {
  if (!isWebLinkToken(input.token)) {
    return {
      ok: false,
      error: "invalid",
      message: "The linking code is malformed. Please refresh the page.",
    };
  }
  if (!isWebLinkIdentityBundle(input.identity)) {
    return {
      ok: false,
      error: "invalid",
      message: "The browser identity is malformed. Please refresh the page.",
    };
  }
  if (input.identity.version !== WEB_LINK_IDENTITY_VERSION) {
    return {
      ok: false,
      error: "invalid",
      message: "The browser identity version is not supported.",
    };
  }
  return { ok: true, token: input.token, identity: input.identity };
}

/** Pure record builder for a successful registration. */
export function newLinkRecord(input: {
  tokenHash: string;
  identity: WebLinkIdentityBundle;
  now: Date;
}): WebLinkRecord {
  return {
    tokenHash: input.tokenHash,
    expiresAt: new Date(input.now.getTime() + WEB_LINK_TTL_MS).toISOString(),
    status: "registered",
    identity: input.identity,
    webDeviceId: webDeviceIdFor(input.identity),
    createdAt: input.now.toISOString(),
  };
}

export function newSessionRecord(input: {
  id: string;
  userId: string;
  deviceId: string;
  publicKey: string;
  sessionToken: string;
  accountName: string;
  now: Date;
}): WebSessionRecord {
  return {
    id: input.id,
    userId: input.userId,
    deviceId: input.deviceId,
    publicKey: input.publicKey,
    tokenHash: secureHash(input.sessionToken),
    accountName: input.accountName,
    createdAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + WEB_SESSION_MAX_AGE_MS).toISOString(),
  };
}

/** ISO expiry of a freshly minted redemption code. */
export function redeemCodeExpiry(now: Date): string {
  return new Date(now.getTime() + WEB_LINK_REDEEM_TTL_MS).toISOString();
}

/**
 * R1.5 — was this link's CURRENT redemption code committed to a push?
 *
 * A pushed code is a PROMISE. Once the backend has emitted a code to the link
 * room, the browser is holding it and will spend exactly that code, so the
 * backend must never quietly replace it. Recorded atomically with the mint
 * (see `WebLinkRecord.redeemPushedAt`) precisely so that decision cannot drift
 * into a read that happens after the fact.
 */
export function isRedeemCodeCommitted(link: WebLinkRecord): boolean {
  return Boolean(link.redeemPushedAt);
}

/**
 * R1.5 — may a RECONNECT re-issue supersede this link's current code?
 *
 * This is the whole re-issue rule, stated once:
 *
 *   - the code must still be live (unspent and inside both TTLs), and
 *   - it must NOT have been committed to a push.
 *
 * The second clause is the fix for a real hand-off defect. Delivery and recovery
 * used to be mutually destructive: approving while a socket was connected pushed
 * code C1, and the very next reconnect rotated it to C2 — leaving the browser
 * holding a code that could no longer be redeemed (`invalid`), with no polling to
 * fall back on, so a benign transport blip silently cost the user their link.
 * Conversely a re-issue racing an approval could supersede the code the approval
 * was about to push, so the browser received a code that was already dead and
 * the live one reached nobody at all.
 *
 * A committed code is therefore never superseded. An UNCOMMITTED one is, because
 * nothing was ever delivered, so rotating it cannot invalidate anything a
 * browser can see — that is precisely the lost-push recovery path.
 *
 * NOT the authority: `WebLinkStore.rotateRedeemCode` enforces this atomically in
 * the same write, and that CAS is what decides the outcome. This predicate is
 * the rule in one readable place (and lets a caller avoid minting a code it is
 * about to throw away).
 */
export function canReissueRedeemCode(link: WebLinkRecord, now: Date): boolean {
  return isRedeemCodeLive(link, now) && !isRedeemCodeCommitted(link);
}

export { WEB_LINK_TTL_MS, WEB_SESSION_MAX_AGE_MS };