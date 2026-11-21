/**
 * Refresh-token issuance, validation, and revocation.
 *
 * Card: "Refresh token storage/hashing + revocation check"
 *
 * Contract (Tech Arch §7.1):
 *   - Refresh token is 30 days, issued alongside the access token.
 *   - The RAW token is returned to the client ONCE; only its bcrypt
 *     hash is stored in the sessions table (DB-2.6).
 *   - A deterministic lookup key (SHA-256 prefix) is stored alongside
 *     the bcrypt hash to allow fast DB index lookups, since bcrypt
 *     hashes are non-deterministic due to random salt.
 *   - On every refresh attempt the lookup key is used to find the row,
 *     then bcrypt.compare verifies the token, and `revoked_at` is
 *     checked — if non-null the session is dead.
 *   - This is the mechanism that makes force-logout work for devices
 *     that aren't currently connected.
 */

import { randomBytes, randomUUID, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, and, isNull } from "drizzle-orm";
import { getDb, type AppDbLike } from "../db/index.js";
import { sessions } from "../db/sessions-schema.js";

// Exported so `verify-refresh.ts` exercises the real values instead of
// re-declaring its own — duplicating these silently drifts and makes the
// verification script assert against a different scheme than production.
export const REFRESH_TOKEN_BYTES = 48; // 384 bits — plenty of entropy
export const BCRYPT_ROUNDS = 12;
const REFRESH_TOKEN_TTL_DAYS = 30;

export function lookupKey(raw: string): string {
  // First 32 hex chars of SHA-256 — deterministic, used for DB index lookup.
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function expiresAt30Days(): Date {
  const now = new Date();
  return new Date(now.getTime() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export type IssueRefreshTokenResult = {
  /** The raw refresh token — return this to the client, then forget it. */
  refreshToken: string;
  /** Session ID — store this in the JWT `sid` claim. */
  sessionId: string;
};

/**
 * Issue a new refresh token.
 *
 * 1. Generate a cryptographically random token.
 * 2. Compute a deterministic lookup key (SHA-256 prefix) for DB queries.
 * 3. Hash the token with bcrypt (12 rounds) for storage.
 * 4. Insert both hashes (+ metadata) into the sessions table.
 * 5. Return the raw token to the caller (who sends it to the client).
 *
 * The raw token is NEVER written to the database.
 */
export async function issueRefreshToken({
  userId,
  deviceId,
  db: dbParam,
  tokenFamilyId,
}: {
  userId: string;
  deviceId: string;
  db?: AppDbLike;
  /** Inherit the family when rotating; omit to start a new family (fresh login). */
  tokenFamilyId?: string;
}): Promise<IssueRefreshTokenResult> {
  const db = dbParam ?? getDb();

  const rawToken = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
  const tokenLookup = lookupKey(rawToken);
  const tokenHash = await bcrypt.hash(rawToken, BCRYPT_ROUNDS);

  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      deviceId,
      tokenLookup,
      refreshTokenHash: tokenHash,
      refreshTokenExpiresAt: expiresAt30Days(),
      tokenFamilyId: tokenFamilyId ?? randomUUID(),
    })
    .returning({ id: sessions.id });

  if (!row) {
    throw new Error("Failed to create session — INSERT RETURNING returned no rows");
  }

  return {
    refreshToken: rawToken,
    sessionId: row.id,
  };
}

export type ValidatedSession = {
  sessionId: string;
  userId: string;
  deviceId: string;
};

/**
 * Validate a refresh token.
 *
 * 1. Compute the deterministic lookup key from the presented token.
 * 2. Look up the session by lookup key (fast DB index hit).
 * 3. Verify the token against the stored bcrypt hash.
 * 4. Reject if not found, wrong token, revoked, or expired.
 *
 * Returns the session metadata on success — enough to mint a new
 * access token without an extra DB round-trip.
 *
 * @param dbParam optional Drizzle handle. Defaults to the shared `getDb()`
 *   instance. Accepting an injected handle matches `issueRefreshToken` and
 *   `revokeAllUserSessions`, and is what allows this function — the single
 *   most security-critical check in the auth path — to be exercised in a test
 *   against a real or stubbed database.
 */
export async function validateRefreshToken(
  rawToken: string,
  dbParam?: AppDbLike,
): Promise<ValidatedSession | null> {
  const db = dbParam ?? getDb();
  const tokenLookup = lookupKey(rawToken);
  const now = new Date();

  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      deviceId: sessions.deviceId,
      refreshTokenHash: sessions.refreshTokenHash,
      revokedAt: sessions.revokedAt,
      expiresAt: sessions.refreshTokenExpiresAt,
    })
    .from(sessions)
    .where(eq(sessions.tokenLookup, tokenLookup))
    .limit(1);

  if (!row) return null;

  // Verify the bcrypt hash — lookup key alone is not sufficient.
  const valid = await bcrypt.compare(rawToken, row.refreshTokenHash);
  if (!valid) return null;

  // Revoked — session was force-logged-out.
  if (row.revokedAt !== null) return null;

  // Expired — 30-day window passed.
  if (row.expiresAt < now) return null;

  return {
    sessionId: row.sessionId,
    userId: row.userId,
    deviceId: row.deviceId,
  };
}

/**
 * Revoke a session by setting `revoked_at` to now.
 *
 * After this call, any refresh attempt with the corresponding token
 * will be rejected by `validateRefreshToken`.
 *
 * Only revokes a session that is still active — the `isNull` guard
 * matches `revokeAllUserSessions` and preserves the original
 * `revoked_at` timestamp if this is called more than once.
 *
 * @param dbParam optional Drizzle handle. Defaults to the shared `getDb()`
 *   instance, matching the other functions in this module.
 */
export async function revokeSession(
  sessionId: string,
  dbParam?: AppDbLike,
): Promise<void> {
  const db = dbParam ?? getDb();

  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/**
 * Revoke every session in a token family.
 *
 * Scoped by `token_family_id` when available. Rows predating rotation have a
 * NULL family, so those fall back to (user_id, device_id) — which is the same
 * set of tokens a pre-rotation client would have held for that device.
 */
async function revokeTokenFamily(
  row: { tokenFamilyId: string | null; userId: string; deviceId: string },
  db: AppDbLike,
): Promise<number> {
  const scope =
    row.tokenFamilyId !== null
      ? eq(sessions.tokenFamilyId, row.tokenFamilyId)
      : and(eq(sessions.userId, row.userId), eq(sessions.deviceId, row.deviceId));

  const result = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(scope, isNull(sessions.revokedAt)));

  return result.rowCount ?? 0;
}

export type RotateRefreshTokenResult =
  | {
      status: "ok";
      refreshToken: string;
      sessionId: string;
      userId: string;
      deviceId: string;
    }
  | { status: "invalid" }
  | { status: "reuse_detected"; revokedCount: number };

/**
 * Rotate a refresh token, detecting reuse of a superseded token.
 *
 * This is the correct entry point for `POST /refresh`. `validateRefreshToken`
 * is read-only and cannot be used here, because rotation needs to WRITE.
 *
 * Flow:
 *   1. Find the row by lookup key, including already-revoked rows — a rotated
 *      token must be findable precisely so reuse can be detected.
 *   2. bcrypt-verify. A mismatch is an ordinary invalid token.
 *   3. If `rotated_at` is set, this token was already superseded. That is the
 *      signature of reuse: either an attacker replayed a stolen token, or a
 *      client failed to store the rotated token. Revoke the whole family.
 *   4. If `revoked_at` is set but `rotated_at` is not, it was an explicit
 *      logout — reject, but do not treat as reuse.
 *   5. CLAIM the row with a conditional UPDATE, then issue the replacement.
 *
 * Step 5 is deliberately claim-first and the claim is what decides the winner.
 * The obvious ordering — issue the replacement, then mark the old row rotated —
 * has a race: two concurrent requests with the same token both read
 * `rotated_at = NULL` and both issue a valid replacement, so rotation protects
 * nothing while appearing to. A single conditional UPDATE makes the claim
 * atomic in the database, so exactly one request can win; the loser observes
 * `rowCount === 0` and is routed to reuse handling like any other replay.
 *
 * Step 3 is the rest of the point: without it a stolen token stays valid for the
 * full 30 days and the theft is both silent and unrevocable.
 */
export async function rotateRefreshToken(
  rawToken: string,
  dbParam?: AppDbLike,
): Promise<RotateRefreshTokenResult> {
  const db = dbParam ?? getDb();
  const tokenLookup = lookupKey(rawToken);
  const now = new Date();

  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      deviceId: sessions.deviceId,
      refreshTokenHash: sessions.refreshTokenHash,
      revokedAt: sessions.revokedAt,
      rotatedAt: sessions.rotatedAt,
      expiresAt: sessions.refreshTokenExpiresAt,
      tokenFamilyId: sessions.tokenFamilyId,
    })
    .from(sessions)
    .where(eq(sessions.tokenLookup, tokenLookup))
    .limit(1);

  if (!row) return { status: "invalid" };

  const tokenMatches = await bcrypt.compare(rawToken, row.refreshTokenHash);
  if (!tokenMatches) return { status: "invalid" };

  // Reuse: this exact token was already rotated. Revoke the entire family.
  if (row.rotatedAt !== null) {
    const revokedCount = await revokeTokenFamily(row, db);
    return { status: "reuse_detected", revokedCount };
  }

  // Explicit logout, or already revoked by a kill-switch — not reuse.
  if (row.revokedAt !== null) return { status: "invalid" };

  if (row.expiresAt < now) return { status: "invalid" };

  // Claim the row. The predicates make this the single point where two racing
  // requests are separated: only one can flip `rotated_at` from NULL.
  const claim = await db
    .update(sessions)
    .set({ rotatedAt: now })
    .where(
      and(
        eq(sessions.id, row.sessionId),
        isNull(sessions.rotatedAt),
        isNull(sessions.revokedAt),
      ),
    );

  // Lost the race — a concurrent request already rotated this token, which is
  // indistinguishable from an attacker replaying it. Same response either way.
  if ((claim.rowCount ?? 0) === 0) {
    const revokedCount = await revokeTokenFamily(row, db);
    return { status: "reuse_detected", revokedCount };
  }

  // We own the claim; issue the successor in the same family.
  const { refreshToken, sessionId } = await issueRefreshToken({
    userId: row.userId,
    deviceId: row.deviceId,
    db,
    tokenFamilyId: row.tokenFamilyId ?? undefined,
  });

  // Record the audit link back from the superseded token to its replacement.
  await db
    .update(sessions)
    .set({ revokedAt: now, replacedBySessionId: sessionId })
    .where(eq(sessions.id, row.sessionId));

  return {
    status: "ok",
    refreshToken,
    sessionId,
    userId: row.userId,
    deviceId: row.deviceId,
  };
}

/**
 * Revoke ALL sessions for a user (force-logout everywhere).
 *
 * Used by ONB-1.7 (new-device login handoff) and by the admin
 * kill-switch.
 */
export async function revokeAllUserSessions(userId: string, db?: AppDbLike): Promise<number> {
  const conn = db ?? getDb();

  const result = await conn
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt), // only revoke active sessions
      ),
    );

  return result.rowCount ?? 0;
}
