// WebLinkStore — storage seam for web-link + web-session records.
//
// MemoryStore is the default (matches the be-5-5 pattern: DB-free, harness-
// friendly). A DB-backed store can be selected later via WEB_LINK_STORE=db
// without touching core.ts's pure transitions (same seam as providers.ts).
//
// ATOMICITY CONTRACT: `createExclusiveSession` is the ONE-BROWSER RULE. It must
// revoke every other active Web session for the user AND create the new one as a
// single indivisible unit — a DB-backed implementation must run it inside one
// transaction (e.g. `BEGIN; UPDATE sessions SET revoked_at=… WHERE user_id=$1 AND
// revoked_at IS NULL AND id<>$new; INSERT …; COMMIT;`). A reader must never be
// able to observe two active Web sessions, nor a moment with none, for the same
// account. It returns the sessions it revoked so the caller can push
// `webForceLoggedOut` to each of them.
//
// ENUMERATION SCOPE CONTRACT (R1.7): EVERY enumeration of sessions on this seam
// is WEB-SESSIONS-ONLY. `listSessionsByUser`, `createExclusiveSession` and the
// per-device revoke are all scoped to `WebSessionRecord` rows and nothing else,
// and that scoping is the whole of R1.7: a PHONE session is never touched, so
// linking a browser can never log the phone out.
//
// The mobile session lives in a different store entirely (the `sessions` table
// in src/db, reached only through `requireAuth`), and this module does not
// import it. That separation is an INVARIANT, not an accident, and it is the
// one thing a DB-backed port is most likely to destroy: the obvious query —
// `SELECT * FROM sessions WHERE user_id = $1` — hits the PHONE table, and
// feeding those rows to `createExclusiveSession` would revoke the user's live
// phone session at the exact moment they link a browser, silently logging them
// out of the app they are scanning with. A DB-backed implementation MUST
// therefore scope every read on this seam to Web sessions (a dedicated
// `web_sessions` table, or an explicit `kind = 'web'` discriminator), and MUST
// never reuse the mobile `sessions` table as the backing store for this seam.
// Note this is a WEAKER obligation than the R1.6 atomicity contract above: it
// constrains WHICH ROWS are read, not how they are read or written.
//
// REVOCATION-AUTHORITY CONTRACT (R1.8): revocation is a SERVER-SIDE fact and
// this seam is its only authority. The rule is one gate — `isWebSessionActive`
// in core.ts, which reports a session dead if it carries a `revokedAt` OR has
// passed `expiresAt` — and every authentication path re-reads the row through
// this seam on EVERY request (`requireWebSession`, `sessionStatus`,
// `realtimeTicket`). Two obligations therefore bind a port, and both are the
// kind a real database breaks by accident rather than by design:
//
//   1. READ-YOUR-WRITES. A `revokedAt` written by `updateSession` — or by
//      `createExclusiveSession`'s in-transaction revoke — MUST be visible to every
//      later read of that row. A read replica, a cache in front of the table, or
//      a request served from a snapshot taken before the write each break R1.8
//      silently, because the whole flow still looks like it worked: `logout`
//      returns ok, the browser clears its cookie, the socket push fires, and the
//      credential keeps authenticating for as long as the stale read is used.
//      Resolve `getSessionByTokenHash` against the primary; never serve a
//      session from any cache that can outlive a revocation.
//   2. SERVER-SIDE DECISION ONLY. `revokedAt` may be written ONLY from an
//      authenticated server decision — the R1.8 `logout`, the mobile device
//      revoke, the R1.6 browser replacement, the R1.9 force logout. No request
//      body, query string or cookie may set it, and no port may infer it from
//      the client's say-so.
//
// The revoked/expired distinction must also survive the port. `revokedAt` records
// a revocation and nothing else: a session that merely aged past the 90-day
// maximum keeps `revokedAt` undefined and is refused by the `expiresAt` half of
// `isWebSessionActive` instead. Backfilling `revokedAt` on expiry would be
// indistinguishable, to every consumer, from a session the user actually logged
// out of — and it is the expiry half, not a write, that keeps a naturally
// expired credential dead.
//
// ATOMICITY CONTRACT (R1.9): `revokeAllActiveSessions` is the NEW-PHONE FORCE
// LOGOUT ("new-phone login revokes every Web session immediately, no grace").
// It is ONE indivisible sweep, and it must be the only way the service performs
// it — a read-then-write loop cannot express the requirement, and a DB-backed
// port will happily reproduce the bug because every line of it is individually
// correct. A DB-backed implementation must run it as a single statement (e.g.
// `UPDATE web_sessions SET revoked_at=$now WHERE user_id=$1 AND revoked_at IS
// NULL RETURNING *`), so the "is it still active?" test and the write are
// evaluated at the same instant, and MUST honour both halves of:
//
//   1. COMPLETENESS. Every Web session active at that instant is ended. A
//      session created or swapped in by a concurrent `createExclusiveSession`
//      must either be caught by this sweep or be a genuinely NEW link — never a
//      session that was already linked when the phone logged in and survived the
//      logout. The read-then-write shape fails this: a browser replacement that
//      interleaves inside the enumeration window leaves its replacement LIVE
//      after the new-phone login has already reported success, and the survivor
//      keeps authenticating — which is precisely the "grace period" the
//      requirement forbids.
  //   2. EXACTNESS. It returns ONLY the rows this call actually ended. Rows that
  //      were already revoked must not be re-revoked, re-counted or re-notified:
  //      over-reporting `revokedCount` and pushing a cutoff into a dead session's
  //      room are how a "we logged out 3 browsers" claim becomes false, and they
  //      are what let the one survivor go un-notified while a corpse is told.
//      Rows that are merely EXPIRED are likewise not ended and not returned — see
  //      the revoked/expired distinction under the R1.8 contract above. A DB-backed
//      implementation must carry both halves into its `WHERE` clause
  //      (`... AND revoked_at IS NULL AND expires_at > $now`).
  //
  //   3. NO AWAIT POINT. Whatever is returned must be decided and written in one
  //      indivisible step, so there is no instant at which another task can
  //      observe a half-applied sweep. That is the whole difference between this
  //      and the read-then-write loop it replaces.
//
// WEB-scope note: this is the R1.7 ENUMERATION SCOPE CONTRACT applied to a
// WRITE, and it binds a port just as hard. The sweep MUST be scoped to Web
// sessions; `UPDATE sessions SET revoked_at=… WHERE user_id=$1` against the
// mobile table would log the phone out of the app that is performing the
// login — the one outcome R1.7 exists to prevent.

import { canReregisterToken, isRedeemCodeCommitted, type WebLinkRecord, type WebLinkStatus, type WebSessionRecord } from "./core.js";

export type WebLinkPatch = Partial<
  Pick<
    WebLinkRecord,
    | "status"
    | "approvedByDeviceId"
    | "approvedByUserId"
    | "accountName"
    | "claimedSessionId"
    | "redeemCodeHash"
    | "redeemExpiresAt"
    | "redeemPushedAt"
  >
>;

export interface WebLinkStore {
  // ── links ──
  createLink(link: WebLinkRecord): Promise<void>;
  getLinkByHash(tokenHash: string): Promise<WebLinkRecord | undefined>;
  /**
   * Returns false when a record already exists for that token hash and may NOT
   * be replaced (see `canReregisterToken` in core.ts — the R1.2 single-use rule).
   *
   * ATOMICITY: a DB-backed implementation must do the read and the write in ONE
   * transaction (e.g. `INSERT … ON CONFLICT (token_hash) DO UPDATE … WHERE
   * status = 'registered' AND expires_at <= $now`), so two concurrent
   * registrations of the same token can never both be admitted.
   */
  createLinkIfAbsent(link: WebLinkRecord, now: Date): Promise<boolean>;
  updateLink(tokenHash: string, patch: WebLinkPatch): Promise<void>;
  /**
   * R1.3 (IDOR-proof) — ATOMIC compare-and-set on a link's status.
   *
   * Moves the link from `expected` to `patch.status` ONLY if it is still in
   * `expected`, and returns whether this caller won. This is what makes
   * "approved exactly once, by exactly one account" and "a redemption code is
   * spent exactly once" real guarantees rather than a read-then-write that a
   * concurrent request can interleave with: without it, two mobiles approving
   * the same token both observe `registered` and both write, and the second
   * silently rebinds the link to a different account.
   *
   * `expectedCodeHash` is optional and, when given, must ALSO still match. The
   * redemption claim uses it: a code that a concurrent `rotateRedeemCode` has
   * already superseded must not be redeemable, or the rotate would hand the
   * browser a fresh code while the stale one still bought a session. The
   * approval claim passes nothing, because a link being approved has no code yet.
   *
   * ATOMICITY: a DB-backed implementation MUST do the compare and the write in
   * one statement (e.g. `UPDATE links SET status=$new, … WHERE token_hash=$h AND
   * status=$expected [AND redeem_code_hash=$code] RETURNING *`) and return false
   * when it affects no rows. A read followed by an unconditional write does NOT
   * satisfy this contract.
   */
  claimLink(
    tokenHash: string,
    expected: WebLinkStatus,
    patch: WebLinkPatch,
    expectedCodeHash?: string,
  ): Promise<boolean>;
  /**
   * ATOMIC compare-and-set on the CURRENT redemption code, for the reconnect
   * re-issue path.
   *
   * Rotating the code is a read-check-write otherwise: `reissueLogin` reads the
   * link, sees the existing code is still live, mints a replacement and writes
   * it. Two reconnects that interleave both pass the check, so both mint, both
   * push, and only the last write is live — the browser is handed N codes of
   * which N-1 are dead, and acting on the first one fails.
   *
   * BOTH halves of the observation must be CAS-ed, not just the code:
   *
   *  - the code hash, so two concurrent reconnects cannot both mint;
   *  - the STATUS, so a rotation cannot land on a link a concurrent `redeem`
   *    has already claimed. Redemption deliberately leaves the old code hash in
   *    place, so a code-only CAS would still succeed there and hand the browser
   *    a freshly minted code for an already-spent link — a code that can never
   *    be redeemed. A rotation is legal only while the link is still `approved`.
   *
   * R1.5 — and a third, which is what makes this the authority for the hand-off
   * rather than just for the re-issue: the current code must NOT already carry a
   * delivery commitment (`redeemPushedAt`). A code that was pushed to the link
   * room is a promise to a browser that is already holding it, and superseding
   * it would hand that browser a code it can no longer spend — with no polling
   * to recover from. An uncommitted code was delivered nowhere, so rotating it
   * invalidates nothing observable and is the legitimate lost-push recovery.
   *
   * This third condition is checked HERE, in the same compare-and-set, and not in
   * the caller: a caller-side pre-check would reintroduce exactly the
   * read-then-write this method exists to prevent (an `approve` interleaving
   * between the read and the write would slip through and the browser would be
   * pushed a superseded code).
   *
   * ATOMICITY: a DB-backed implementation MUST compare and write in one
   * statement (e.g. `UPDATE links SET redeem_code_hash=$new, redeem_expires_at=$e
   * WHERE token_hash=$h AND status='approved' AND redeem_code_hash=$code
   * AND redeem_pushed_at IS NULL RETURNING *`), false on zero rows.
   */
  rotateRedeemCode(
    tokenHash: string,
    expected: { status: "approved"; codeHash: string },
    patch: WebLinkPatch,
  ): Promise<boolean>;
  /** Look a live record up by the hash of a redemption code. */
  getLinkByRedeemHash(redeemHash: string): Promise<WebLinkRecord | undefined>;

  // ── sessions ──
  /**
   * The one-browser transaction: revoke every other active Web session for
   * `session.userId` and store `session`, atomically. Returns the revoked
   * sessions so the caller can push the cutoff event to them.
   */
  createExclusiveSession(
    session: WebSessionRecord,
    revokedAt: string,
  ): Promise<WebSessionRecord[]>;
  getSessionByTokenHash(tokenHash: string): Promise<WebSessionRecord | undefined>;
  getSessionById(id: string): Promise<WebSessionRecord | undefined>;
  /**
   * R1.7 — WEB SESSIONS ONLY, never the caller's phone session. See the
   * ENUMERATION SCOPE CONTRACT at the top of this file. This is the single read
   * every session-scope decision goes through (the one-browser transaction,
   * the device list, device revoke, new-phone force logout), which is exactly
   * why it must not be allowed to widen: a phone row here is a user logged out
   * of the app they are linking from.
   */
  listSessionsByUser(userId: string): Promise<WebSessionRecord[]>;
  /**
   * R1.9 — the new-phone force logout, as ONE indivisible sweep. Revoke every
   * Web session of `userId` that is active at the instant of the call, and
   * return only the rows this call actually ended (see ATOMICITY CONTRACT (R1.9)
   * at the top of this file). `revokedAt` is a stamp, not a predicate, so a
   * session whose lifetime has merely lapsed is NOT swept and NOT returned —
   * expiry stays the `expiresAt` half of `isWebSessionActive`, per the
   * REVOCATION-AUTHORITY CONTRACT (R1.8).
   *
   * A read-then-write loop (`listSessionsByUser` + `updateSession` per row)
   * MUST NOT be substituted for this: it is the defect R1.9 exists to close.
   */
  revokeAllActiveSessions(userId: string, revokedAt: string): Promise<WebSessionRecord[]>;
  /**
   * R1.8 — this is where a revocation becomes authoritative. `revokedAt` is the
   * ONLY field here that ends a credential, and it is only ever written from an
   * authenticated server decision; `lastSeenAt` must never be able to make a
   * dead session look alive to a reader. Writes MUST be immediately visible to
   * later reads (READ-YOUR-WRITES, see the REVOCATION-AUTHORITY CONTRACT at the
   * top of this file) — that visibility is the entire server-side guarantee.
   */
  updateSession(
    id: string,
    patch: Partial<Pick<WebSessionRecord, "lastSeenAt" | "revokedAt">>,
  ): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryWebLinkStore implements WebLinkStore {
  private links = new Map<string, WebLinkRecord>();
  private sessions = new Map<string, WebSessionRecord>();
  private sessionByTokenHash = new Map<string, string>();
  private linkByRedeemHash = new Map<string, string>();

  async createLink(link: WebLinkRecord): Promise<void> {
    this.links.set(link.tokenHash, link);
  }

  async getLinkByHash(tokenHash: string): Promise<WebLinkRecord | undefined> {
    return this.links.get(tokenHash);
  }

  async createLinkIfAbsent(link: WebLinkRecord, now: Date): Promise<boolean> {
    const existing = this.links.get(link.tokenHash);
    // R1.2 single-use: a token that was already APPROVED (or claimed) is dead
    // forever, and a live one is dead until its TTL lapses. Only a token that
    // expired while still merely registered may be replaced. Note the decision
    // uses the caller's injected `now`, never the wall clock, so the TTL is the
    // same clock the rest of the state machine is tested against.
    if (existing && !canReregisterToken(existing, now)) return false;
    this.links.set(link.tokenHash, link);
    return true;
  }

  /**
   * Single place that keeps the redeem-hash secondary index consistent with the
   * primary record, so every write path (update/claim/rotate) cannot drift.
   */
  private applyLinkPatch(existing: WebLinkRecord, next: WebLinkRecord): void {
    this.links.set(next.tokenHash, next);
    if (existing.redeemCodeHash && existing.redeemCodeHash !== next.redeemCodeHash) {
      this.linkByRedeemHash.delete(existing.redeemCodeHash);
    }
    if (next.redeemCodeHash) this.linkByRedeemHash.set(next.redeemCodeHash, next.tokenHash);
  }

  async updateLink(tokenHash: string, patch: WebLinkPatch): Promise<void> {
    const existing = this.links.get(tokenHash);
    if (!existing) return;
    this.applyLinkPatch(existing, { ...existing, ...patch });
  }

  async claimLink(
    tokenHash: string,
    expected: WebLinkStatus,
    patch: WebLinkPatch,
    expectedCodeHash?: string,
  ): Promise<boolean> {
    const existing = this.links.get(tokenHash);
    if (!existing) return false;
    if (existing.status !== expected) return false;
    if (expectedCodeHash !== undefined && existing.redeemCodeHash !== expectedCodeHash) return false;
    this.applyLinkPatch(existing, { ...existing, ...patch });
    return true;
  }

  async rotateRedeemCode(
    tokenHash: string,
    expected: { status: "approved"; codeHash: string },
    patch: WebLinkPatch,
  ): Promise<boolean> {
    const existing = this.links.get(tokenHash);
    if (!existing) return false;
    if (existing.status !== expected.status) return false;
    if (existing.redeemCodeHash !== expected.codeHash) return false;
    // R1.5: a code already committed to a push is a promise to the browser that
    // is holding it. Superseding it here is what used to make the recovery path
    // destroy the delivery path, so it is refused in the same atomic step.
    if (isRedeemCodeCommitted(existing)) return false;
    this.applyLinkPatch(existing, { ...existing, ...patch });
    return true;
  }

  async getLinkByRedeemHash(redeemHash: string): Promise<WebLinkRecord | undefined> {
    const tokenHash = this.linkByRedeemHash.get(redeemHash);
    if (!tokenHash) return undefined;
    return this.links.get(tokenHash);
  }

  async createExclusiveSession(
    session: WebSessionRecord,
    revokedAt: string,
  ): Promise<WebSessionRecord[]> {
    const revoked: WebSessionRecord[] = [];
    for (const existing of this.sessions.values()) {
      if (existing.userId !== session.userId || existing.id === session.id) continue;
      if (existing.revokedAt) continue;
      const next = { ...existing, revokedAt };
      this.sessions.set(existing.id, next);
      revoked.push(next);
    }
    this.sessions.set(session.id, session);
    this.sessionByTokenHash.set(session.tokenHash, session.id);
    return revoked;
  }

  async getSessionByTokenHash(tokenHash: string): Promise<WebSessionRecord | undefined> {
    const id = this.sessionByTokenHash.get(tokenHash);
    if (!id) return undefined;
    return this.sessions.get(id);
  }

  async getSessionById(id: string): Promise<WebSessionRecord | undefined> {
    return this.sessions.get(id);
  }

  async listSessionsByUser(userId: string): Promise<WebSessionRecord[]> {
    const out: WebSessionRecord[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId === userId) out.push(session);
    }
    return out;
  }

  async revokeAllActiveSessions(userId: string, revokedAt: string): Promise<WebSessionRecord[]> {
    // R1.9: one indivisible sweep, mirroring `createExclusiveSession`. The loop
    // below contains NO await, so no other async task can interleave between the
    // liveness test and the write — the in-process equivalent of a single
    // `UPDATE … WHERE revoked_at IS NULL RETURNING *`. Both the test and the
    // write are on this `sessions` map, which is web-only by the R1.7
    // ENUMERATION SCOPE CONTRACT; a phone row cannot be reached from here.
    //
    // Rows whose lifetime already lapsed are skipped, and `revokedAt` doubles as
    // the sweep's stamp (the server's `now`) so no clock has to be threaded in.
    // That is R1.8's revoked/expired distinction doing real work: a session that
    // merely aged out keeps `revokedAt` undefined and stays refused by the
    // `expiresAt` half of `isWebSessionActive`. Stamping it here would make an
    // expiry indistinguishable, to every consumer, from a revocation the user
    // actually asked for — and the sweep is the one path that touches every row
    // of the account, so it is the one path that would do that damage.
    const revoked: WebSessionRecord[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId !== userId) continue;
      if (session.revokedAt) continue;
      if (session.expiresAt <= revokedAt) continue;
      const next = { ...session, revokedAt };
      this.sessions.set(session.id, next);
      revoked.push(next);
    }
    return revoked;
  }

  async updateSession(
    id: string,
    patch: Partial<Pick<WebSessionRecord, "lastSeenAt" | "revokedAt">>,
  ): Promise<void> {
    const existing = this.sessions.get(id);
    if (!existing) return;
    this.sessions.set(id, { ...existing, ...patch });
  }

  async clear(): Promise<void> {
    this.links.clear();
    this.sessions.clear();
    this.sessionByTokenHash.clear();
    this.linkByRedeemHash.clear();
  }
}

let instance: WebLinkStore | undefined;

/** App-wide singleton. Default: in-memory (DB-free). */
export function getWebLinkStore(): WebLinkStore {
  if (!instance) {
    // Production seam: WEB_LINK_STORE=db → plug a DB-backed store here later.
    // The memory store satisfies the Sprint 3 contract and is fully tested.
    instance = new MemoryWebLinkStore();
  }
  return instance;
}

/** Test hook: swap the app-wide store instance. */
export function setWebLinkStoreForTest(store: WebLinkStore): void {
  instance = store;
}

export function resetWebLinkStore(): Promise<void> {
  const store = getWebLinkStore();
  return store.clear();
}
