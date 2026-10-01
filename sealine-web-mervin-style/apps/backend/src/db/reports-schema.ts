/**
 * DB-2.4 — Reports table.
 *
 * Keyed by phone_hash (NOT user_id). One row per user report.
 * Holds the bounded decrypted_message_snapshot (jsonb) that is
 * populated automatically by a database trigger on report_evidence
 * (see migration 005_fix_reports_and_moderation.sql).
 *
 * Extra columns (migration 015_add_report_columns.sql):
 *   reason_category     — report_reason_category enum, NOT NULL default
 *                         'other'; new inserts MUST supply a real value.
 *   reported_group_id   — uuid NULL, FK -> groups(id) ON DELETE SET NULL.
 *                         A report targets a user (reported_phone_hash) OR
 *                         a group. SET NULL so the report survives group
 *                         deletion (deletion never auto-dismisses a report;
 *                         matches audit_log.report_id's SET NULL pattern).
 *   evidence_expires_at — timestamptz NOT NULL; set by the DB trigger
 *                         tg_reports_evidence_expiry as created_at + 30d
 *                         when not supplied (evidence purge rule S15.4).
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { pgEnum } from "drizzle-orm/pg-core";
import { groups } from "./groups-schema.js";

export const reportStatus = pgEnum("report_status", [
  "pending",
  "reviewed",
  "actioned",
  "dismissed",
]);

export const reportReasonCategory = pgEnum("report_reason_category", [
  "spam",
  "harassment",
  "inappropriate_content",
  "other",
]);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reporterPhoneHash: text("reporter_phone_hash").notNull(),
    reportedPhoneHash: text("reported_phone_hash").notNull(),
    reportedGroupId: uuid("reported_group_id").references(
      () => groups.id,
      { onDelete: "set null" },
    ),
    reasonCategory: reportReasonCategory("reason_category")
      .notNull()
      .default("other"),
    status: reportStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    evidenceExpiresAt: timestamp("evidence_expires_at", {
      withTimezone: true,
    }).notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    actionedAt: timestamp("actioned_at", { withTimezone: true }),
    decryptedMessageSnapshot: jsonb("decrypted_message_snapshot"),
  },
  (table) => [
    index("reports_reporter_phone_hash_idx").on(table.reporterPhoneHash),
    index("reports_reported_phone_hash_idx").on(table.reportedPhoneHash),
    index("reports_status_idx").on(table.status),
    index("reports_reported_group_id_idx").on(table.reportedGroupId),
  ],
);