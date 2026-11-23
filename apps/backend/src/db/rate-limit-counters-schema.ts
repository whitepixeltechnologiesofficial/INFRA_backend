/**
 * DB-2.6 — Rate limit counters table (migration 021).
 *
 * Fixed-window counters shared across backend instances, e.g.
 * action='message_send', subject=<user id>. Use the SQL function
 * rate_limit_hit(action, subject, window_seconds), which atomically
 * counts one hit and returns the window's new total; compare it with
 * the limit. Expired windows are purged hourly by pg_cron.
 */

import { pgTable, varchar, text, timestamp, integer, primaryKey, index } from "drizzle-orm/pg-core";

export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    action: varchar("action", { length: 64 }).notNull(),
    subject: text("subject").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [
    primaryKey({ name: "rate_limit_counters_pk", columns: [table.action, table.subject, table.windowStart] }),
    index("rate_limit_counters_window_end_idx").on(table.windowEnd),
  ],
);
