/**
 * BE-5.5 - Message status table (sent / delivered / read / failed).
 *
 * pending_messages rows are deleted once delivered, so the sender-visible
 * status lives here. Metadata only: no ciphertext and no recipient device
 * ids. One row per logical message, aggregated across the recipient's
 * devices. See migrations/019_message_status.sql for the full rationale.
 */

import { pgTable, uuid, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { devices } from "./devices-schema.js";

export const MESSAGE_STATES = ["sent", "delivered", "read", "failed"] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

export const messageStatus = pgTable(
  "message_status",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    senderDeviceId: uuid("sender_device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    senderUserId: uuid("sender_user_id").notNull(),
    clientMessageId: uuid("client_message_id").notNull(),
    recipientUserId: uuid("recipient_user_id").notNull(),
    state: text("state").$type<MessageState>().notNull().default("sent"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // BE-5.7: one row per RECIPIENT. A 1:1 message still has exactly one row; a group message
    // has one row per recipient member, which is what gives per-recipient status.
    unique("message_status_sender_msg_recipient_uniq").on(
      table.senderDeviceId,
      table.clientMessageId,
      table.recipientUserId,
    ),
    index("idx_message_status_sender_updated").on(table.senderDeviceId, table.updatedAt),
    index("idx_message_status_expires").on(table.expiresAt),
    index("idx_message_status_recipient").on(table.recipientUserId),
  ],
);
