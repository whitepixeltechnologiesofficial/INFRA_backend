/**
 * DB-2.6 — Chat mutes table (migration 021).
 *
 * Which chats a user has muted, so notifications skip them. A row
 * targets EITHER a 1:1 chat (mutedUserId) OR a group (groupId) — the DB
 * enforces exactly one. mutedUntil NULL = muted indefinitely.
 *
 * In the database, user_id / muted_user_id take the live type of
 * users.id; they are typed here to match the Drizzle users schema.
 */

import { pgTable, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users-schema.js";
import { groups } from "./groups-schema.js";

export const chatMutes = pgTable(
  "chat_mutes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mutedUserId: uuid("muted_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    groupId: uuid("group_id").references(() => groups.id, { onDelete: "cascade" }),
    mutedUntil: timestamp("muted_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chat_mutes_user_peer_uidx")
      .on(table.userId, table.mutedUserId)
      .where(sql`${table.mutedUserId} IS NOT NULL`),
    uniqueIndex("chat_mutes_user_group_uidx")
      .on(table.userId, table.groupId)
      .where(sql`${table.groupId} IS NOT NULL`),
  ],
);
