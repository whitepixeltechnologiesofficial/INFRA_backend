/**
 * DB-2.7 — Phone-number reuse cooldown (Tech Arch S6.9).
 *
 * After a phone number is freed (account deleted), it may not be
 * re-registered for 48 hours. Keyed by phone_hash (like blocks and
 * reports) so the cooldown survives account delete-and-recreate.
 *
 * Rows are released (deleted) by the scheduled run_data_cleanup()
 * job only once cooldown_until <= now() — never before the 48h
 * window has elapsed. See migration 009_create_data_cleanup.sql.
 */

import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export const phoneReuseCooldowns = pgTable(
  "phone_reuse_cooldowns",
  {
    phoneHash: text("phone_hash").primaryKey(),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_phone_reuse_cooldowns_until").on(table.cooldownUntil),
  ],
);