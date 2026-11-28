/**
 * DB-2.1 — Users table.
 *
 * One row per registered user. The phone number is the primary
 * identifier for authentication and must be unique — the
 * application-level check in OTP-verify (§7.2 step 2) queries
 * this table to decide whether a verified phone number belongs
 * to an existing account or a new one.
 *
 * The unique constraint on phone_number is enforced at both the
 * DB level (UNIQUE index) and the application level (query before
 * insert). This prevents duplicate accounts for the same number.
 */

import { pgTable, pgEnum, uuid, varchar, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/** Architecture §6.1 — moderation state of an account (migration 022). */
export const accountStatus = pgEnum("account_status", ["active", "warned", "restricted", "banned"]);

export const users = pgTable(
  "users",
  {
    /** Primary key — UUID (Architecture §6.1). */
    id: uuid("id").primaryKey().defaultRandom(),

    /** Phone number in E.164 format — unique across all users. */
    phoneNumber: varchar("phone_number", { length: 20 }).notNull(),

    /** Display name — set during profile setup. */
    name: varchar("name", { length: 100 }).notNull().default(""),

    /** Profile photo — stored as base64 data URI or external URL. */
    photo: text("photo"),

    /** About / bio — user-provided, max ~500 chars. */
    about: text("about"),

    /** Moderation state — active unless a moderator acts (§6.1). */
    accountStatus: accountStatus("account_status").notNull().default("active"),

    /** Row creation time. */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Last profile update time. */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Unique constraint on phone_number — prevents duplicate accounts.
    // This is the enforced check referenced in DB-2.1.
    uniqueIndex("users_phone_number_unique").on(table.phoneNumber),
    // Fast lookup by phone number (the hot path on OTP-verify).
    index("users_phone_number_idx").on(table.phoneNumber),
    index("users_account_status_idx").on(table.accountStatus),
  ],
);
