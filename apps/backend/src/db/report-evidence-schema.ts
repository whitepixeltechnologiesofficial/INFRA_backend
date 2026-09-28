/**
 * DB-2.4 — Report evidence table.
 *
 * One row per captured message for a report. Security-privacy
 * design (Tech Arch §6.6): a decrypted_message_snapshot (jsonb)
 * column holds a BOUNDED snapshot of message evidence, capped at
 * the smaller of { the last 20 messages OR all messages from the
 * last 7 days }.
 *
 * The cap is ENFORCED in the database layer:
 *   - a BEFORE INSERT trigger rejects rows beyond 20 messages or
 *     outside the 7-day window;
 *   - an AFTER STATEMENT trigger rebuilds the jsonb snapshot on
 *     the parent report and every evidence row.
 *
 * metadata_snapshot — jsonb, nullable. Structured message metadata
 * captured at report time (message_type, size_bytes, etc.) — NOT
 * plaintext content, which lives in decrypted_message_snapshot.
 * Added: BE-R2.3, migration 014.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { reports } from "./reports-schema.js";

export const reportEvidence = pgTable(
  "report_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    messageContent: text("message_content"),
    messageCreatedAt: timestamp("message_created_at", {
      withTimezone: true,
    }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decryptedMessageSnapshot: jsonb("decrypted_message_snapshot"),
    metadataSnapshot: jsonb("metadata_snapshot"),
    mediaBucket: text("media_bucket"),
    mediaPath: text("media_path"),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_report_evidence_report_id").on(table.reportId),
  ],
);
