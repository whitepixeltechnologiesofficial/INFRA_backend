/**
 * DB-2.2 — Pending messages table.
 *
 * Per-device message queue: one row per recipient device. A message
 * to a user with N devices creates N rows, one per recipient_device_id.
 *
 * ciphertext is stored as bytea (never plaintext). Integer size_bytes
 * holds the ciphertext length. The recipient must be exactly one of
 * { recipient_user_id, recipient_device_id, recipient_group_id } —
 * enforced by the pending_messages_recipient_exactly_one CHECK constraint.
 */

import {
  pgTable,
  uuid,
  customType,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { devices } from "./devices-schema.js";

/** bytea column: stores binary ciphertext as a Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return value;
  },
  fromDriver(value) {
    return value;
  },
});

export const pendingMessages = pgTable(
  "pending_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    senderDeviceId: uuid("sender_device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    recipientDeviceId: uuid("recipient_device_id").notNull(),
    recipientUserId: uuid("recipient_user_id"),
    recipientGroupId: uuid("recipient_group_id"),
    ciphertext: bytea("ciphertext").notNull(),
    messageType: text("message_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    mediaPath: text("media_path"),
    replyToId: uuid("reply_to_id"),
    voiceSegmentGroupId: uuid("voice_segment_group_id"),
    // BE-5.4: client-generated id; makes send retries idempotent (migration 018).
    clientMessageId: uuid("client_message_id"),
  },
  (table) => [
    index("idx_pending_messages_recipient_user").on(table.recipientUserId),
    index("idx_pending_messages_recipient_device").on(table.recipientDeviceId),
    index("idx_pending_messages_recipient_group").on(table.recipientGroupId),
    index("idx_pending_messages_expires").on(table.expiresAt),
    index("idx_pending_messages_created").on(table.createdAt),
    index("idx_pending_messages_voice_group").on(table.voiceSegmentGroupId),
    uniqueIndex("pending_messages_client_msg_uniq_idx").on(
      table.senderDeviceId,
      table.recipientDeviceId,
      table.clientMessageId,
    ),
  ],
);