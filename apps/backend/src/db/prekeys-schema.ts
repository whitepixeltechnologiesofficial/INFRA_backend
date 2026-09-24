/**
 * BE-5.2: Prekey tables for X3DH key distribution.
 *
 * signed_prekeys: one current signed prekey per device (older ones are
 * kept with replaced_at set, so they can be phased out later).
 * one_time_prekeys: a stack of single-use keys per device. A key is
 * handed out at most once (claimed_at is set when it is given away).
 *
 * Keys are stored as text, matching devices.identity_public_key.
 */

import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { devices } from "./devices-schema.js";

export const signedPrekeys = pgTable(
  "signed_prekeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    signature: text("signature").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    replacedAt: timestamp("replaced_at", { withTimezone: true }),
  },
  (table) => [
    index("signed_prekeys_device_id_idx").on(table.deviceId),
    // Only one current (not replaced) signed prekey per device.
    uniqueIndex("signed_prekeys_one_current_per_device_idx")
      .on(table.deviceId)
      .where(sql`${table.replacedAt} is null`),
  ],
);

export const oneTimePrekeys = pgTable(
  "one_time_prekeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (table) => [
    index("one_time_prekeys_device_claimed_idx").on(table.deviceId, table.claimedAt),
    uniqueIndex("one_time_prekeys_device_key_idx").on(table.deviceId, table.publicKey),
  ],
);