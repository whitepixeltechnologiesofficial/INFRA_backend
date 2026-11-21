/**
 * BE-5.5 - Message status state machine and sender push.
 *
 * States: sent < delivered < read, plus failed.
 *   - sent      : server accepted and queued the message (green clock)
 *   - delivered : ANY recipient device acked it (grey circle)
 *   - read      : ANY recipient device reported it read (blue circle)
 *   - failed    : the SENDER reported bounded retries exhausted (red clock)
 *
 * "Recipient offline" is NOT a failure (Tech Arch S9.3): the message stays
 * `sent` until the recipient reconnects and acks it.
 *
 * Every transition is a single conditional UPDATE, so concurrent acks from
 * two recipient devices cannot double-fire or downgrade the state.
 */

import { and, eq, inArray, gt, sql } from "drizzle-orm";
import type { AppDbLike } from "./index.js";
import { messageStatus, type MessageState } from "./message-status-schema.js";
import { pushToDevice } from "../ws/socket-registry.js";

export const STATUS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Reasons a sender may report. A closed set: no free text is stored. */
export const FAILURE_REASONS = ["RETRIES_EXHAUSTED", "NETWORK_ERROR", "REJECTED_BY_SERVER"] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export type StatusRow = typeof messageStatus.$inferSelect;

export type StatusEvent = {
  clientMessageId: string;
  state: MessageState;
  sentAt: Date;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  updatedAt: Date;
};

export function toStatusEvent(row: StatusRow): StatusEvent {
  return {
    clientMessageId: row.clientMessageId,
    state: row.state,
    sentAt: row.sentAt,
    deliveredAt: row.deliveredAt,
    readAt: row.readAt,
    failedAt: row.failedAt,
    failureReason: row.failureReason,
    updatedAt: row.updatedAt,
  };
}

const newExpiry = () => new Date(Date.now() + STATUS_TTL_MS);

/** Create the `sent` row. Call inside the same transaction as the pending_messages insert. */
export async function recordSent(
  db: AppDbLike,
  args: {
    senderDeviceId: string;
    senderUserId: string;
    clientMessageId: string;
    recipientUserId: string;
  },
): Promise<StatusRow> {
  const [row] = await db
    .insert(messageStatus)
    .values({ ...args, state: "sent", expiresAt: newExpiry() })
    .returning();
  return row!;
}

export async function getStatus(
  db: AppDbLike,
  senderDeviceId: string,
  clientMessageId: string,
): Promise<StatusRow | null> {
  const [row] = await db
    .select()
    .from(messageStatus)
    .where(
      and(
        eq(messageStatus.senderDeviceId, senderDeviceId),
        eq(messageStatus.clientMessageId, clientMessageId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Move a message UP to `delivered` or `read`. Returns the updated row when the
 * state actually changed, or null when it was a no-op (already at/above `to`,
 * unknown message, or - for read - the caller is not the recipient).
 * A null return means: do not push.
 */
export async function escalate(
  db: AppDbLike,
  args: {
    senderDeviceId: string;
    clientMessageId: string;
    to: "delivered" | "read";
    /** When set, the row must belong to this recipient user (read receipts). */
    recipientUserId?: string;
  },
): Promise<StatusRow | null> {
  const from: MessageState[] = args.to === "delivered" ? ["sent", "failed"] : ["sent", "delivered", "failed"];
  const now = new Date();

  // Read implies delivered: COALESCE keeps delivered_at truthful (set once, on
  // first delivery) even when a read receipt arrives before any delivery ack.
  const [row] = await db
    .update(messageStatus)
    .set({
      state: args.to,
      deliveredAt: sql`COALESCE(${messageStatus.deliveredAt}, ${now.toISOString()}::timestamptz)`,
      failedAt: null,
      failureReason: null,
      updatedAt: now,
      expiresAt: newExpiry(),
      ...(args.to === "read" ? { readAt: now } : {}),
    })
    .where(
      and(
        eq(messageStatus.senderDeviceId, args.senderDeviceId),
        eq(messageStatus.clientMessageId, args.clientMessageId),
        inArray(messageStatus.state, from),
        ...(args.recipientUserId ? [eq(messageStatus.recipientUserId, args.recipientUserId)] : []),
      ),
    )
    .returning();
  return row ?? null;
}

export type FailOutcome =
  | { outcome: "updated" | "already_failed"; row: StatusRow }
  | { outcome: "conflict"; row: StatusRow } // already delivered/read: cannot fail
  | { outcome: "not_found" };

/** Sender reports bounded retries exhausted. Only a `sent` message can fail. */
export async function markFailed(
  db: AppDbLike,
  senderDeviceId: string,
  clientMessageId: string,
  reason: FailureReason,
): Promise<FailOutcome> {
  const now = new Date();
  const [row] = await db
    .update(messageStatus)
    .set({ state: "failed", failedAt: now, failureReason: reason, updatedAt: now, expiresAt: newExpiry() })
    .where(
      and(
        eq(messageStatus.senderDeviceId, senderDeviceId),
        eq(messageStatus.clientMessageId, clientMessageId),
        eq(messageStatus.state, "sent"),
      ),
    )
    .returning();
  if (row) return { outcome: "updated", row };

  const existing = await getStatus(db, senderDeviceId, clientMessageId);
  if (!existing) return { outcome: "not_found" };
  if (existing.state === "failed") return { outcome: "already_failed", row: existing };
  return { outcome: "conflict", row: existing };
}

/** Sender retried a failed message (PRD 8.2): failed -> sent. No-op for any other state. */
export async function resetFailedToSent(
  db: AppDbLike,
  senderDeviceId: string,
  clientMessageId: string,
): Promise<StatusRow | null> {
  const now = new Date();
  const [row] = await db
    .update(messageStatus)
    .set({ state: "sent", failedAt: null, failureReason: null, updatedAt: now, expiresAt: newExpiry() })
    .where(
      and(
        eq(messageStatus.senderDeviceId, senderDeviceId),
        eq(messageStatus.clientMessageId, clientMessageId),
        eq(messageStatus.state, "failed"),
      ),
    )
    .returning();
  return row ?? null;
}

/** Sender catch-up after being offline. Only ever the caller's own device's messages. */
export async function listForSender(
  db: AppDbLike,
  senderDeviceId: string,
  opts: { clientMessageIds?: string[]; since?: Date },
): Promise<StatusRow[]> {
  const conds = [eq(messageStatus.senderDeviceId, senderDeviceId), gt(messageStatus.expiresAt, new Date())];
  if (opts.clientMessageIds?.length) conds.push(inArray(messageStatus.clientMessageId, opts.clientMessageIds));
  if (opts.since) conds.push(gt(messageStatus.updatedAt, opts.since));
  return db
    .select()
    .from(messageStatus)
    .where(and(...conds))
    .orderBy(messageStatus.updatedAt)
    .limit(500);
}

/**
 * Real-time push to the SENDER's live socket. Call only AFTER the transaction
 * that changed the row has committed. `false` is normal (sender offline): the
 * row is durable and the sender catches up via POST /relay/status/sync.
 */
export function pushStatusToSender(row: StatusRow): boolean {
  return pushToDevice(row.senderUserId, row.senderDeviceId, "message_status", toStatusEvent(row));
}
