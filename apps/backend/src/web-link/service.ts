// Web-link / web-session service — the backend authority for the whole
// linking lifecycle.
//
// Backend-enforced invariants:
//   R1.1  the BROWSER generates the token (secure browser CSPRNG) and
//         REGISTERS it with its public identity before any QR is rendered
//   R1.2  tokens are opaque, single-use, 60s TTL — the store keeps only SHA-256
//   R1.3  validate/approve require the MOBILE to be authenticated (IDOR-proof)
//   R1.4  approval binds the account + the browser's registered public key
//   R1.5  the backend PUSHES the hand-off; the Web never polls for it
//   R1.6  the one-browser transaction runs at REDEEM, i.e. exactly at the
//         moment authority transfers: revoke every prior Web session for the
//         account and create the new one, indivisibly
//   R1.7  linking enumerates Web sessions only — a phone session is never
//         touched, so linking a browser can never log the phone out
//   R1.8  web sessions are revocable; revocation is authoritative server-side
//   R1.9  new-phone login revokes every Web session immediately (no grace)
//
// No raw secret is ever persisted: tokens, redemption codes and session
// credentials are stored exclusively as SHA-256 digests. That is also why a
// reconnect cannot replay the original code — it is re-issued, not recalled.

import { randomUUID } from "node:crypto";
import {
  WEB_LINK_REDEEM_TTL_MS,
  WEB_LINK_TTL_MS,
  webLinkQrPayload,
  type LinkedWebDevice,
  type WebLinkIdentityBundle,
  type WebLinkLoginPush,
  type WebLinkRegisterResult,
} from "@wpt/shared";
import { randomToken, secureHash } from "./crypto.js";
import {
  canReissueRedeemCode,
  isRedeemCodeLive,
  isWebLinkExpired,
  isWebLinkRegistered,
  isWebSessionActive,
  newLinkRecord,
  newSessionRecord,
  redeemCodeExpiry,
  validateRegistration,
  webDeviceIdFor,
  type WebLinkRecord,
  type WebSessionRecord,
} from "./core.js";
import { getWebLinkStore, type WebLinkStore } from "./store.js";
import { issueLinkTicket, issueRealtimeTicket } from "./ticket.js";
import {
  emitWebLinkLogin,
  emitWebSessionTerminated,
  isLinkSocketConnected,
} from "./socket-registry.js";

type Rejection = {
  ok: false;
  error: "invalid" | "expired" | "already_used" | "not_approved";
  message: string;
};

export interface RegisterInput {
  token?: unknown;
  identity?: unknown;
  now?: Date;
}

export interface ApproveInput {
  mobileUserId: string;
  mobileDeviceId: string;
  accountName?: string;
  now?: Date;
}

export function createWebLinkService(store: WebLinkStore = getWebLinkStore()) {
  /**
   * Reduce the two questions every step shares: does this token exist, and is
   * it still inside its 60s window and unused?
   */
  async function resolveUsable(
    token: unknown,
    now: Date,
  ): Promise<{ ok: true; link: WebLinkRecord } | Rejection> {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
      return { ok: false, error: "invalid", message: "This QR code is invalid." };
    }
    const link = await store.getLinkByHash(secureHash(token));
    if (!link) {
      return { ok: false, error: "invalid", message: "This QR code is invalid." };
    }
    if (isWebLinkExpired(link, now)) {
      return {
        ok: false,
        error: "expired",
        message: "This QR code has expired. Please scan the new QR code.",
      };
    }
    // Only a `registered` link can still be approved, so `registered` is the only
    // state in which this QR is usable. Anything else (already approved by another
    // phone, or already spent) is dead to BOTH `validate` and `approve`, which is
    // what keeps the two endpoints from disagreeing with each other: `validate`
    // must never tell a phone "this QR is valid" for a link that `approve` would
    // then refuse.
    if (!isWebLinkRegistered(link)) {
      return {
        ok: false,
        error: "already_used",
        message: "This QR code has already been used.",
      };
    }
    return { ok: true, link };
  }

  /**
   * R1.1/R1.2 — The browser presents a token it generated itself plus its
   * PUBLIC identity. The backend validates the shape, refuses a token that is
   * already live, and records SHA-256(token) with a 60s TTL. The raw token is
   * never stored, so the token stays the browser's bearer secret while the
   * backend's authority stays limited to existence / age / used-state.
   */
  async function register(input: RegisterInput): Promise<
    | {
        ok: true;
        linkId: string;
        qrPayload: string;
        expiresAt: string;
        ttlMs: number;
        identity: WebLinkIdentityBundle;
        webDeviceId: string;
      }
    | { ok: false; error: "invalid" | "already_used"; message: string }
  > {
    const now = input.now ?? new Date();
    const checked = validateRegistration({ token: input.token, identity: input.identity });
    if (!checked.ok) return checked;

    const link = newLinkRecord({
      tokenHash: secureHash(checked.token),
      identity: checked.identity,
      now,
    });

    const admitted = await store.createLinkIfAbsent(link, now);
    if (!admitted) {
      return {
        ok: false,
        error: "already_used",
        message: "This QR code is already registered.",
      };
    }

    return {
      ok: true,
      linkId: link.tokenHash,
      qrPayload: webLinkQrPayload(checked.token),
      expiresAt: link.expiresAt,
      ttlMs: WEB_LINK_TTL_MS,
      identity: checked.identity,
      webDeviceId: link.webDeviceId,
    };
  }

  /** `register` plus the link ticket the browser needs in order to be pushed to. */
  async function registerWithTicket(
    input: RegisterInput,
  ): Promise<
    | WebLinkRegisterResult
    | { ok: false; error: "invalid" | "already_used"; message: string }
  > {
    const res = await register(input);
    if (!res.ok) return res;
    const linkTicket = await issueLinkTicket({ linkId: res.linkId });
    return {
      ok: true,
      linkId: res.linkId,
      qrPayload: res.qrPayload,
      expiresAt: res.expiresAt,
      ttlMs: res.ttlMs,
      linkTicket,
    };
  }

  /**
   * R1.3 — Mobile validates a scanned token. Requires an authenticated mobile
   * session (enforced by the route) and a token that is still usable.
   */
  async function validate(
    token: string,
    now?: Date,
  ): Promise<
    | { ok: true; accountName: string; valid: true; expiresAt: string }
    | Rejection
  > {
    const target = now ?? new Date();
    const res = await resolveUsable(token, target);
    if (!res.ok) return res;
    return { ok: true, accountName: "you", valid: true, expiresAt: res.link.expiresAt };
  }

  /**
   * R1.4/R1.5 — Mobile approves a scanned token. This binds the account to the
   * browser's registered public identity and mints a single-use redemption
   * code, which is PUSHED to the browser that owns the link.
   *
   * Identity comes ONLY from the authenticated mobile JWT (never a body field);
   * the browser's public key comes ONLY from the registration record (never
   * from this request). Neither side can impersonate the other.
   *
   * The minted code is ALSO returned to the caller. It is not a session
   * credential and it is already a single-use 60s bearer whose only sanctioned
   * journey is server-to-server, so handing it back here changes nothing about
   * what it is. What it enables is the one thing the push could not: a caller
   * with no browser socket in the room can still complete the protocol. The
   * production `/web-link/:token/approve` route deliberately does NOT put it on
   * the wire — the browser's copy arrives by PUSH, as designed — and only the
   * dev-only `_dev/scan` trigger may ask for it explicitly.
   */
  async function approve(
    token: string,
    input: ApproveInput,
    now?: Date,
  ): Promise<
    | {
        ok: true;
        approved: true;
        userId: string;
        webDeviceId: string;
        /** The single-use redemption code just minted (never a session credential). */
        code: string;
        codeExpiresAt: string;
        linkExpiresAt: string;
      }
    | Rejection
  > {
    const target = now ?? new Date();
    const res = await resolveUsable(token, target);
    if (!res.ok) return res;
    const link = res.link;

    const accountName = input.accountName || "Account";
    const code = randomToken();
    const expiresAt = redeemCodeExpiry(target);

    // R1.5 — the push that follows this claim is a PROMISE to the browser that is
    // about to receive the code, and the promise has to be recorded in the SAME
    // atomic write that mints the code. Recording it separately (or inferring it
    // later) is what let the reconnect re-issue supersede a code the room had
    // already been sent, so the browser held a code that could no longer be
    // redeemed and — with no polling by design — had no way back.
    //
    // The commitment is made only when a link socket is actually joined to the
    // room, i.e. only when this push has somewhere to land. A code minted while
    // no browser is listening is delivered nowhere, so it is left uncommitted and
    // the re-issue is free to supersede it: that is exactly the lost-push
    // recovery, and it is why recovery survives this change.
    //
    // `isLinkSocketConnected` is read BEFORE the claim and is not part of the
    // guarantee — the authority is the claim itself. A socket that drops in the
    // microsecond between the two leaves a committed code that was never
    // delivered, which fails toward "the user re-scans" rather than toward
    // "the browser is pushed a dead code". Narrow, and the safe direction.
    const commitPush = isLinkSocketConnected(link.tokenHash);

    // R1.3 (IDOR-proof) - the approval is a CLAIM, not a write. Only the caller
    // that atomically moves the link out of `registered` may mint a code and push
    // it, so a second mobile (or a concurrent double-tap) can never rebind an
    // already-approved link to a different account. `claimLink` is the ONLY
    // thing standing between two approvals and a cross-account hand-off, so it
    // - not a preceding read - decides the outcome. Losing the race is reported
    // as `already_used`, the same answer a sequential second approval gets.
    const claimed = await store.claimLink(link.tokenHash, "registered", {
      status: "approved",
      approvedByUserId: input.mobileUserId,
      approvedByDeviceId: input.mobileDeviceId,
      accountName,
      redeemCodeHash: secureHash(code),
      redeemExpiresAt: expiresAt,
      ...(commitPush ? { redeemPushedAt: target.toISOString() } : {}),
    });
    if (!claimed) {
      return {
        ok: false,
        error: "already_used",
        message: "This QR code has already been used.",
      };
    }

    // Safe by construction now: the claim is committed when the push is
    // addressed, so no `reissueLogin` can rotate this code between the claim
    // above and this emit. A reconnect racing this line declines instead, and the
    // browser receives the one code that is actually live.
    emitWebLinkLogin(link.tokenHash, {
      code,
      expiresAt,
      linkExpiresAt: link.expiresAt,
    } satisfies WebLinkLoginPush);

    return {
      ok: true,
      approved: true,
      userId: input.mobileUserId,
      webDeviceId: link.webDeviceId,
      code,
      codeExpiresAt: expiresAt,
      linkExpiresAt: link.expiresAt,
    };
  }

  /**
   * The reconnect half of the push design. A link socket that re-joins its room
   * while an approval is still unspent is issued a FRESH code rather than the
   * original one, because the original was only ever held in memory. No timer,
   * no polling — just "here is the decision I already made, in a fresh envelope".
   *
   * R1.5 — it re-issues only what is safe to re-issue. A code that was already
   * committed to a push is returned untouched (null), because the browser holding
   * it must keep the one code that works; see `canReissueRedeemCode`. This is
   * what makes the recovery path stop destroying the delivery path.
   */
  async function reissueLogin(
    linkId: string,
    now?: Date,
  ): Promise<WebLinkLoginPush | null> {
    const target = now ?? new Date();
    const link = await store.getLinkByHash(linkId);
    // Cheap guard so we do not mint a code the CAS is going to refuse. The CAS
    // below is the authority, not this read.
    if (!link || !canReissueRedeemCode(link, target)) return null;
    const code = randomToken();
    const expiresAt = redeemCodeExpiry(target);
    // Rotate the code ATOMICALLY against the exact state this decision was
    // based on. Checking `canReissueRedeemCode` and then writing unconditionally
    // is a TOCTOU: concurrent reconnects all observe the same live code, all mint,
    // all push, and only the last write survives — leaving the browser holding
    // several codes of which all but one are already dead. The CAS closes that,
    // and because redemption leaves the old code hash in place it also has to
    // compare the status, so a re-issue racing a successful redeem declines
    // instead of minting a code for an already-claimed link. Its third condition
    // is the R1.5 commitment: a code already pushed to the room is never
    // superseded, and an `approve` interleaving here can no longer be pushed a
    // code that has just been rotated out from under it.
    const rotated = await store.rotateRedeemCode(linkId, {
      status: "approved",
      codeHash: link.redeemCodeHash as string,
    }, {
      redeemCodeHash: secureHash(code),
      redeemExpiresAt: expiresAt,
    });
    if (!rotated) return null;
    return { code, expiresAt, linkExpiresAt: link.expiresAt };
  }

  /**
   * R1.6 — The browser exchanges the pushed code for its session. Server-to-
   * server (BFF → backend) and the only place a Web session credential is ever
   * produced for the client.
   *
   * This is also where the ONE-BROWSER RULE runs, because this is the instant
   * authority actually transfers to the browser: one store call revokes every
   * prior active Web session for the account and inserts the new one, so no
   * reader can ever see two active Web browsers. Each revoked session is then
   * told to `force_logout`.
   */
  async function redeem(
    code: unknown,
    now?: Date,
  ): Promise<
    | {
        ok: true;
        sessionToken: string;
        userId: string;
        deviceId: string;
        webSessionId: string;
        accountName: string;
        expiresAt: string;
        replacedSessions: number;
      }
    | Rejection
  > {
    const target = now ?? new Date();
    if (typeof code !== "string" || !/^[0-9a-f]{64}$/.test(code)) {
      return { ok: false, error: "invalid", message: "This link is no longer available." };
    }
    const link = await store.getLinkByRedeemHash(secureHash(code));
    if (!link) {
      return { ok: false, error: "invalid", message: "This link is no longer available." };
    }
    if (!isRedeemCodeLive(link, target)) {
      return { ok: false, error: "expired", message: "This link is no longer available." };
    }

    const userId = link.approvedByUserId;
    if (!userId) {
      return { ok: false, error: "not_approved", message: "This link is not approved." };
    }

    // R1.2/R1.3 — spending the code is a CLAIM, and it happens BEFORE the
    // session is created. Reading "is this code still live?" and then writing
    // `claimed` afterwards would let two concurrent redeems of one code both
    // proceed: the second would revoke the session the first had just created
    // (one-browser rule) and hand its caller a credential that is already dead,
    // with no error. Claiming first means exactly one caller can ever reach the
    // session creation, and it fails closed if that step throws.
    const sessionToken = randomToken();
    const session: WebSessionRecord = newSessionRecord({
      id: randomUUID(),
      userId,
      deviceId: link.webDeviceId,
      publicKey: link.identity.publicKey,
      sessionToken,
      accountName: link.accountName ?? "Account",
      now: target,
    });

    // Burn the link: `approved` -> `claimed`, AND only if this is still the very
    // code that was presented. Status alone is not enough — a reconnect
    // re-issue that rotated the code between the read above and this claim
    // leaves the status at `approved` while changing the code, and burning on
    // status alone would let the SUPERSEDED code buy a session (leaving the
    // browser holding the rotate's fresh, now-dead code instead). Comparing
    // the code hash makes the two operations mutually exclusive: exactly one of
    // them can win, and whichever loses reports `already_used`.
    const burned = await store.claimLink(
      link.tokenHash,
      "approved",
      {
        status: "claimed",
        claimedSessionId: session.id,
      },
      link.redeemCodeHash as string,
    );
    if (!burned) {
      return { ok: false, error: "already_used", message: "This link is no longer available." };
    }

    // ── THE ONE-BROWSER TRANSACTION (indivisible) ────────────────────────────
    const replaced = await store.createExclusiveSession(session, target.toISOString());
    for (const old of replaced) {
      emitWebSessionTerminated(old.id, "replaced_by_new_browser");
    }
    // ────────────────────────────────────────────────────────────────────────

    return {
      ok: true,
      sessionToken,
      userId,
      deviceId: session.deviceId,
      webSessionId: session.id,
      accountName: session.accountName,
      expiresAt: session.expiresAt,
      replacedSessions: replaced.length,
    };
  }

  /** R1.7 core — validate a web session token server-side. */
  async function sessionStatus(
    token: string,
    now?: Date,
  ): Promise<{
    ok: boolean;
    userId?: string;
    deviceId?: string;
    webSessionId?: string;
    expiresAt?: string;
  }> {
    const session = await store.getSessionByTokenHash(secureHash(token));
    if (!session) return { ok: false };
    if (!isWebSessionActive(session, now ?? new Date())) return { ok: false };
    return {
      ok: true,
      userId: session.userId,
      deviceId: session.deviceId,
      webSessionId: session.id,
      expiresAt: session.expiresAt,
    };
  }

  /** R1.8 — server-side session logout (revokes immediately). */
  async function logout(token: string, now?: Date): Promise<{ ok: boolean }> {
    const session = await store.getSessionByTokenHash(secureHash(token));
    if (!session) return { ok: false };
    await store.updateSession(session.id, { revokedAt: (now ?? new Date()).toISOString() });
    emitWebSessionTerminated(session.id, "logged_out");
    return { ok: true };
  }

  /** Realtime ticket. Requires a valid session token (the caller already has one). */
  async function realtimeTicket(token: string): Promise<{ ok: boolean; ticket?: string }> {
    const session = await store.getSessionByTokenHash(secureHash(token));
    if (!session) return { ok: false };
    if (!isWebSessionActive(session, new Date())) return { ok: false };
    const ticket = await issueRealtimeTicket({
      userId: session.userId,
      deviceId: session.deviceId,
      webSessionId: session.id,
    });
    return { ok: true, ticket };
  }

  /** Mobile device detail for list/revoke (deviceId + linkedAt + lastSeen). */
  async function listDevices(
    userId: string,
    now?: Date,
  ): Promise<{ devices: LinkedWebDevice[] }> {
    const sessions = await store.listSessionsByUser(userId);
    const t = now ?? new Date();
    const seen = new Map<string, LinkedWebDevice>();
    for (const s of sessions) {
      const active = isWebSessionActive(s, t);
      const d = seen.get(s.deviceId);
      if (!d) {
        seen.set(s.deviceId, {
          deviceId: s.deviceId,
          linkedAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          revokedAt: s.revokedAt,
        });
      }
      if (!active && d) d.revokedAt = d.revokedAt ?? s.revokedAt;
    }
    return { devices: Array.from(seen.values()) };
  }

  /** Mobile revokes a web device immediately (kill-switch applies to all its sessions). */
  async function revokeDevice(
    userId: string,
    deviceId: string,
    now?: Date,
  ): Promise<
    | { ok: true; revokedAt: string }
    | { ok: false; error: "not_authorized" | "unknown"; message: string }
  > {
    const sessions = await store.listSessionsByUser(userId);
    const matching = sessions.filter((s) => s.deviceId === deviceId && !s.revokedAt);
    if (matching.length === 0) {
      return { ok: false, error: "unknown", message: "This device is not linked." };
    }
    const revokedAt = (now ?? new Date()).toISOString();
    for (const s of matching) {
      await store.updateSession(s.id, { revokedAt });
      emitWebSessionTerminated(s.id, "device_revoked");
    }
    return { ok: true, revokedAt };
  }

  /**
   * R1.9 — revoke ALL of a user's WEB sessions (new-phone login, etc.). Scoped
   * to Web sessions by construction, so a new phone login kills the browsers
   * without ever touching the phone session it just created.
   *
   * The sweep is ONE store call. It used to be `listSessionsByUser` followed by
   * a per-row `updateSession` loop, which could not satisfy the requirement: a
   * browser replacement interleaving inside that window produced a session that
   * was already linked when the phone logged in yet stayed LIVE afterwards, and
   * its room was never told — while the loop re-counted and re-pushed the rows
   * that were already dead. That window IS the "grace period" the requirement
   * forbids. See ATOMICITY CONTRACT (R1.9) in store.ts.
   *
   * The push stays a prompt, not the authority (R1.8): it is emitted only for
   * the rows this call actually ended, and a missed push costs the browser its
   * live view, never its access — the next request fails `isWebSessionActive`
   * server-side. `revokedAt` carries the same stamp, so re-running the sweep
   * after a second phone login reports the sessions the SECOND login killed and
   * never re-pushes an already-dead session.
   */
  async function revokeUserWebSessions(
    userId: string,
    reason: string,
    now?: Date,
  ): Promise<{ revokedCount: number }> {
    const revoked = await store.revokeAllActiveSessions(
      userId,
      (now ?? new Date()).toISOString(),
    );
    for (const s of revoked) {
      emitWebSessionTerminated(s.id, reason);
    }
    return { revokedCount: revoked.length };
  }

  return {
    register,
    registerWithTicket,
    validate,
    approve,
    reissueLogin,
    redeem,
    sessionStatus,
    logout,
    realtimeTicket,
    listDevices,
    revokeDevice,
    revokeUserWebSessions,
    isLinkSocketConnected,
    webDeviceIdFor,
    ttlMs: WEB_LINK_TTL_MS,
    redeemTtlMs: WEB_LINK_REDEEM_TTL_MS,
    debug: {
      async linkCount(): Promise<number> {
        const anyStore = store as unknown as { links?: Map<string, unknown> };
        return anyStore?.links?.size ?? 0;
      },
    },
  };
}

export type WebLinkService = ReturnType<typeof createWebLinkService>;

let memo: { store: WebLinkStore; service: WebLinkService } | null = null;

/**
 * App-wide service, resolved per call so it always tracks the CURRENT store
 * instance. Routes must call this inside each handler rather than capturing a
 * service at module load: a store swap (test harness, or a future DB-backed
 * `WEB_LINK_STORE=db` selection) would otherwise leave a handler holding a
 * service bound to the previous store forever.
 */
export function getWebLinkService(): WebLinkService {
  const store = getWebLinkStore();
  if (!memo || memo.store !== store) {
    memo = { store, service: createWebLinkService(store) };
  }
  return memo.service;
}
