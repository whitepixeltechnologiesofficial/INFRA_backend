/**
 * DB — Push devices table.
 *
 * Stores one row per registered device push token (Scenario 3.4/3.5 grant
 * path, Tech Arch §14.x). When the Notifications OS permission is granted the
 * client registers its Expo push token (APNs on iOS, FCM on Android) here so
 * the server can fan out alerts to the right devices — including when the app
 * is backgrounded.
 *
 * A device token is bound to a user + device pair and is unique per install.
 * Re-registering the same (user, device) upserts the token — the newer token
 * wins. `platform` records whether it is an iOS or Android install for provider
 * bookkeeping.
 */

import { pgTable, uuid, varchar, timestamp, index, unique } from "drizzle-orm/pg-core";

export const pushDevices = pgTable(
  "push_devices",
  {
    /** Primary key — push-device registration id. */
    id: uuid("id").primaryKey().defaultRandom(),

    /** The user who owns this device registration. */
    userId: varchar("user_id", { length: 64 }).notNull(),

    /** The device that was registered (from the JWT deviceId claim). */
    deviceId: varchar("device_id", { length: 64 }).notNull(),

    /** Expo push token: `ExponentPushToken[...]` (APNs/FCM-backed). */
    token: varchar("token", { length: 200 }).notNull(),

    /** Which OS installed the app: "ios" | "android". */
    platform: varchar("platform", { length: 16 }).notNull(),

    /** When this registration was created. */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** When it was last re-registered / updated. */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One live registration per user+device install. Re-registration upserts.
    unique("push_devices_user_device_unique").on(table.userId, table.deviceId),
    // Fan-out by user (send a message to every device the user owns).
    index("push_devices_user_id_idx").on(table.userId),
  ],
);
