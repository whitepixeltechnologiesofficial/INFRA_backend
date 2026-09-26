/**
 * BE-5.2: Drizzle definitions for the prekey tables.
 *
 * These tables ALREADY EXIST in the database (created by the earlier
 * ENC-4.1 work, 006_prekey_tables.sql on origin/enc/prekey-bundle) and
 * hold live rows. This file only describes them; BE-5.2 does not
 * create, alter or drop them.
 *
 * signed_prekeys: many per device; the CURRENT one is the highest key_id.
 * one_time_prekeys: consumed_at is set when a key is handed out.
 * A database CHECK requires public keys and signatures to be base64
 * strings of 40-128 characters.
 */

import { pgTable, uuid, text, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { devices } from "./devices-schema.js";

export const signedPrekeys = pgTable(
  "signed_prekeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    keyId: integer("key_id").notNull(),
    publicKey: text("public_key").notNull(),
    signature: text("signature").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("signed_prekeys_device_key_unique").on(table.deviceId, table.keyId)],
);

export const oneTimePrekeys = pgTable(
  "one_time_prekeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    keyId: integer("key_id").notNull(),
    publicKey: text("public_key").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("one_time_prekeys_device_key_unique").on(table.deviceId, table.keyId)],
);