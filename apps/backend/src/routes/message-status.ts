/**
 * BE-5.5 - Message status routes (mounted at /relay/status).
 *
 *   POST /relay/status/read    RECIPIENT reports a message read  -> sender's indicator turns blue
 *   POST /relay/status/failed  SENDER reports bounded retries exhausted -> red clock
 *   POST /relay/status/sync    SENDER catch-up after being offline
 *
 * `sent` is created by POST /relay/send and `delivered` by POST /relay/ack;
 * neither has a route here. Live changes are pushed to the sender's socket as
 * a `message_status` event; sync is the durable fallback for an offline sender.
 */

import { Router, type Request, type Response } from "express";
import { getDb } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import {
  FAILURE_REASONS,
  escalate,
  listForSender,
  markFailed,
  pushStatusToSender,
  toStatusEvent,
  type FailureReason,
} from "../db/message-status.js";
import { messageStatus } from "../db/message-status-schema.js";
import { and, eq } from "drizzle-orm";

const router: Router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SYNC_IDS = 200;

// ── POST /relay/status/read ── Body: { senderDeviceId, clientMessageId }
// Any device of the recipient user may report it (multi-device: any device
// escalates). Someone who is not the recipient gets the same 404 as an unknown
// message, so this cannot be used to probe which messages exist.
router.post("/read", async (req: Request, res: Response) => {
  try {
    const authUserId = res.locals.auth!.sub;
    const { senderDeviceId, clientMessageId } = req.body as {
      senderDeviceId?: string;
      clientMessageId?: string;
    };
    if (typeof senderDeviceId !== "string" || !UUID_RE.test(senderDeviceId)) {
      res.status(400).json({ error: "INVALID_SENDER_DEVICE_ID" });
      return;
    }
    if (typeof clientMessageId !== "string" || !UUID_RE.test(clientMessageId)) {
      res.status(400).json({ error: "INVALID_CLIENT_MESSAGE_ID" });
      return;
    }

    const db = getDb();
    const changed = await escalate(db, {
      senderDeviceId,
      clientMessageId,
      to: "read",
      recipientUserId: authUserId,
    });

    if (changed) {
      const pushed = pushStatusToSender(changed);
      res.json({ success: true, changed: true, state: changed.state, senderPushed: pushed });
      return;
    }

    // No-op: either already read (fine, idempotent) or not the caller's message (404).
    const [mine] = await db
      .select()
      .from(messageStatus)
      .where(
        and(
          eq(messageStatus.senderDeviceId, senderDeviceId),
          eq(messageStatus.clientMessageId, clientMessageId),
          eq(messageStatus.recipientUserId, authUserId),
        ),
      )
      .limit(1);
    if (!mine) {
      res.status(404).json({ error: "MESSAGE_NOT_FOUND" });
      return;
    }
    res.json({ success: true, changed: false, state: mine.state, senderPushed: false });
  } catch {
    console.error("POST /relay/status/read error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /relay/status/failed ── Body: { clientMessageId, reason? }
// The SENDER reports that bounded retries were exhausted for a message the
// server had already accepted (e.g. the response was lost). A message that
// never reached the server has no row here; its red clock is purely local.
// A message that was already delivered/read cannot fail: 409.
router.post("/failed", async (req: Request, res: Response) => {
  try {
    const authDeviceId = res.locals.auth!.deviceId;
    const { clientMessageId, reason } = req.body as { clientMessageId?: string; reason?: string };
    if (typeof clientMessageId !== "string" || !UUID_RE.test(clientMessageId)) {
      res.status(400).json({ error: "INVALID_CLIENT_MESSAGE_ID" });
      return;
    }
    const why = reason ?? "RETRIES_EXHAUSTED";
    if (!(FAILURE_REASONS as readonly string[]).includes(why)) {
      res.status(400).json({ error: "INVALID_FAILURE_REASON", allowed: FAILURE_REASONS });
      return;
    }

    const result = await markFailed(getDb(), authDeviceId, clientMessageId, why as FailureReason);
    if (result.outcome === "not_found") {
      res.status(404).json({ error: "MESSAGE_NOT_FOUND" });
      return;
    }
    if (result.outcome === "conflict") {
      res.status(409).json({ error: "ALREADY_" + result.row.state.toUpperCase(), status: toStatusEvent(result.row) });
      return;
    }
    res.json({ success: true, changed: result.outcome === "updated", status: toStatusEvent(result.row) });
  } catch {
    console.error("POST /relay/status/failed error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /relay/status/sync ── Body: { clientMessageIds?: string[], since?: ISO date }
// Returns the current status of this device's sent messages. Call on every
// (re)connect with the `serverTime` from the previous sync as `since`.
// Ids that are absent have no server-side status (never accepted, or aged out
// after 30 days): the client keeps whatever it shows locally.
router.post("/sync", async (req: Request, res: Response) => {
  try {
    const authDeviceId = res.locals.auth!.deviceId;
    const { clientMessageIds, since } = req.body as { clientMessageIds?: unknown; since?: unknown };

    let ids: string[] | undefined;
    if (clientMessageIds !== undefined) {
      if (
        !Array.isArray(clientMessageIds) ||
        clientMessageIds.length === 0 ||
        clientMessageIds.length > MAX_SYNC_IDS ||
        !clientMessageIds.every((v) => typeof v === "string" && UUID_RE.test(v))
      ) {
        res.status(400).json({ error: `clientMessageIds must be 1..${MAX_SYNC_IDS} uuids` });
        return;
      }
      ids = clientMessageIds as string[];
    }
    let sinceDate: Date | undefined;
    if (since !== undefined) {
      sinceDate = typeof since === "string" ? new Date(since) : new Date(NaN);
      if (Number.isNaN(sinceDate.getTime())) {
        res.status(400).json({ error: "INVALID_SINCE" });
        return;
      }
    }
    if (!ids && !sinceDate) {
      res.status(400).json({ error: "Provide clientMessageIds and/or since" });
      return;
    }

    // Captured BEFORE the query so a change landing mid-request is re-sent next time, never lost.
    const serverTime = new Date();
    const rows = await listForSender(getDb(), authDeviceId, { clientMessageIds: ids, since: sinceDate });
    res.json({ statuses: rows.map(toStatusEvent), serverTime: serverTime.toISOString() });
  } catch {
    console.error("POST /relay/status/sync error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
