/**
 * DB-2.6 — Dashboard sessions table (migration 021).
 *
 * Admin Dashboard logins ONLY. Deliberately a separate table from
 * `sessions` (user/device auth): its only FK is dashboard_admins(id),
 * so dashboard and user auth can never share a session row.
 *
 * Column layout matches the table already live on Supabase (created by
 * the dashboard-auth work, src/auth/dashboard.ts on Team-Beta):
 * token_lookup (first 32 hex chars of SHA-256) for indexed lookup,
 * refresh_token_hash (bcrypt) for verification, refresh_token_expires_at
 * for expiry and revoked_at as the kill switch. The raw token is never
 * stored.
 */

import { pgTable, uuid, varchar, text, timestamp, index } from "drizzle-orm/pg-core";
import { dashboardAdmins } from "./dashboard-admins-schema.js";

export const dashboardSessions = pgTable(
  "dashboard_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => dashboardAdmins.id, { onDelete: "cascade" }),
    tokenLookup: varchar("token_lookup", { length: 32 }).notNull(),
    refreshTokenHash: varchar("refresh_token_hash", { length: 60 }).notNull(),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("dashboard_sessions_admin_id_idx").on(table.adminId),
    index("dashboard_sessions_token_lookup_idx").on(table.tokenLookup),
    index("dashboard_sessions_revoked_at_idx").on(table.revokedAt),
  ],
);

export type DashboardSessionRow = typeof dashboardSessions.$inferSelect;
export type DashboardSessionInsert = typeof dashboardSessions.$inferInsert;
