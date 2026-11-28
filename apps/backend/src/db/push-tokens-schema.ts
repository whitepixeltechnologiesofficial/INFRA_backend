/**
 * PERM-2.5 — Push tokens table (migration 019).
 *
 * One Expo push token per device. Owned by the device row, so a revoked
 * or deleted device can never be alerted.
 */

import { pgTable, uuid, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { users } from "./users-schema.js";
import { devices } from "./devices-schema.js";

export const pushTokens = pgTable(
  "push_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    platform: text("platform").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("push_tokens_token_unique").on(table.token),
    unique("push_tokens_device_unique").on(table.deviceId),
    index("push_tokens_user_id_idx").on(table.userId),
  ],
);
