/**
 * DB-2.6 — Sessions table.
 *
 * Stores one row per active device session. The refresh token is
 * stored as a bcrypt hash — the raw token is only ever held in
 * memory on the server side and in the client's secure storage.
 *
 * A deterministic lookup key (first 32 hex chars of SHA-256) is
 * stored alongside the bcrypt hash to allow fast DB index lookups,
 * since bcrypt hashes are non-deterministic and cannot be used as
 * lookup keys.
 *
 * `revoked_at` is the kill-switch column: setting it to a non-null
 * timestamp instantly invalidates the session for any device that
 * attempts a token refresh (§7.1).
 */

import { pgTable, uuid, varchar, timestamp, index } from "drizzle-orm/pg-core";

export const sessions = pgTable(
  "sessions",
  {
    /** Primary key — session identifier (referenced by JWT `sid` claim). */
    id: uuid("id").primaryKey().defaultRandom(),

    /** The user who owns this session. */
    userId: varchar("user_id", { length: 64 }).notNull(),

    /** The device that was authenticated. */
    deviceId: varchar("device_id", { length: 64 }).notNull(),

    /**
     * Deterministic lookup key — first 32 hex chars of SHA-256(raw_token).
     * Used for fast DB index lookups; bcrypt hash is used for actual
     * verification (bcrypt is non-deterministic due to random salt).
     */
    tokenLookup: varchar("token_lookup", { length: 32 }).notNull(),

    /**
     * Bcrypt hash of the refresh token (12 rounds).
     * The raw token is NEVER stored — only this hash.
     */
    refreshTokenHash: varchar("refresh_token_hash", { length: 60 }).notNull(),

    /** When the refresh token expires (30 days from issuance). */
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }).notNull(),

    /**
     * Kill-switch column (§7.1).
     * NULL = session is active.
     * Non-null = session has been revoked; any refresh attempt must be rejected.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    /**
     * Rotation marker. NULL = this token was never rotated.
     *
     * Non-null means the token was superseded by a refresh, which is what
     * distinguishes REUSE (a stolen token replayed after the legitimate client
     * already rotated it) from an ordinary logout. Without this column the two
     * are indistinguishable and reuse cannot be detected.
     */
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),

    /**
     * Groups every token descended from a single login, so reuse of any one of
     * them can revoke the whole chain.
     *
     * NULL on rows created before rotation existed. Reuse handling falls back to
     * (user_id, device_id) scoping for those, which is a safe approximation:
     * it can revoke a legitimate device session, never less than that.
     */
    tokenFamilyId: uuid("token_family_id"),

    /** Audit link: the session that superseded this one. */
    replacedBySessionId: uuid("replaced_by_session_id"),

    /** Row creation time. */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Fast lookup by user (for "log out all devices" flows).
    index("sessions_user_id_idx").on(table.userId),
    // Fast lookup by token_lookup (the hot path on every refresh).
    index("sessions_token_lookup_idx").on(table.tokenLookup),
    // Reuse detection revokes by family.
    index("sessions_token_family_idx").on(table.tokenFamilyId),
  ],
);
