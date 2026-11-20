/**
 * DB-2.2 — Message relay routes.
 *
 * Used for functional verification of the pending_messages table:
 *  - POST /relay/send  — create a pending_messages row for a recipient
 *  - POST /relay/poll   — fetch undelivered messages for a device
 *  - POST /relay/ack    — mark a message as delivered
 *
 * The per-device model is: for a recipient with N devices, the sender
 * creates N pending_messages rows — one per recipient_device_id.
 */

import { Router, type Request, type Response } from "express";
import { eq, and, or, isNull, isNotNull, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import { devices } from "../db/devices-schema.js";
import { users } from "../db/users-schema.js";
import { blocks } from "../db/blocks-schema.js";
import { pendingMessages } from "../db/pending-messages-schema.js";
import {
  escalate,
  getStatus,
  pushStatusToSender,
  recordSent,
  resetFailedToSent,
  toStatusEvent,
} from "../db/message-status.js";
import { phoneHash } from "../utils/phone-hash.js";
import { pushToDevice } from "../ws/socket-registry.js";
import { pushTokens } from "../db/push-tokens-schema.js";
import { sendExpoPush } from "../push/expo-push.js";

const router: Router = Router();

router.use(requireAuth);

/** Allowed message types (mirrors the DB enum to avoid 22P02 500s). */
const MESSAGE_TYPES = new Set(["text", "image", "video", "audio", "file", "system"]);

// ──────────────────────────────────────────────────
// DB-2.4 block enforcement — app-layer guard before insert.
//
// The blocks table is keyed by phone_hash (blocker + blocked directions)
// and there are NO RLS policies (authorization is entirely app-layer).
// Therefore relay/send must reject messages when a block exists in EITHER
// direction (A banned B → neither A→B nor B→A may proceed, per DB-2.4's
// "bidirectional block" requirement), and relay/poll must never hand a
// blocked sender's message to its recipient.
// ──────────────────────────────────────────────────

/** Resolve the phone hash for a user id from the users table. */
export async function resolvePhoneHashForUser(
  userId: string,
  db: ReturnType<typeof getDb>,
): Promise<string | null> {
  const [row] = await db
    .select({ phoneNumber: users.phoneNumber })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ? phoneHash(row.phoneNumber) : null;
}

/** True when a block exists between two hashes in EITHER direction. */
export async function hasBlockBetween(
  hashA: string,
  hashB: string,
  db: ReturnType<typeof getDb>,
): Promise<boolean> {
  const [row] = await db
    .select({ blockerPhoneHash: blocks.blockerPhoneHash })
    .from(blocks)
    .where(
      or(
        and(eq(blocks.blockerPhoneHash, hashA), eq(blocks.blockedPhoneHash, hashB)),
        and(eq(blocks.blockerPhoneHash, hashB), eq(blocks.blockedPhoneHash, hashA)),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * The set of phone hashes with which the given hash has a block in either
 * direction. poll uses this to filter out messages from blocked partners.
 */
export async function blockedPartnerHashes(
  selfHash: string,
  db: ReturnType<typeof getDb>,
): Promise<Set<string>> {
  const rows = await db
    .select({
      blockerPhoneHash: blocks.blockerPhoneHash,
      blockedPhoneHash: blocks.blockedPhoneHash,
    })
    .from(blocks)
    .where(or(eq(blocks.blockerPhoneHash, selfHash), eq(blocks.blockedPhoneHash, selfHash)));
  const partners = new Set<string>();
  for (const r of rows) {
    partners.add(r.blockerPhoneHash === selfHash ? r.blockedPhoneHash : r.blockerPhoneHash);
  }
  return partners;
}

/** Strict hex ciphertext validation — reject silently-truncated garbage. */
function isValidHexCiphertext(v: unknown): v is string {
  if (typeof v !== "string" || !v) return false;
  if (v.length % 2 !== 0) return false;
  if (v.length > 200_000) return false; // ~100 KB binary, matches 100kb body cap
  return /^[0-9a-fA-F]+$/.test(v);
}

/** Whether a message is addressed to a given user (user fan-out OR device ownership). */
function isAddressedToUser(authUserId: string): ReturnType<typeof sql> {
  return or(
    eq(pendingMessages.recipientUserId, authUserId),
    sql`EXISTS (SELECT 1 FROM devices WHERE devices.id = ${pendingMessages.recipientDeviceId} AND devices.user_id = ${authUserId})`,
  )!;
}

// ──────────────────────────────────────────────────
// POST /relay/send   (BE-5.4)
//
// The server is a BLIND relay: it stores and forwards opaque ciphertext
// and never decrypts. Each recipient DEVICE has its own Double Ratchet
// session, so a 1:1 send carries one ciphertext PER recipient device.
//
// Body: {
//   clientMessageId: string,          // client-generated UUID, makes retries idempotent
//   messageType?: string,
//   // 1:1 (preferred) — per-device envelopes, all devices of ONE user:
//   recipients?: [{ deviceId: string, ciphertext: string /* hex */ }],
//   // Legacy DB-2.2-V shapes, still accepted:
//   ciphertext?: string,              // hex, same blob to every targeted device
//   recipientUserId?: string,         //   -> one row per active device of that user
//   recipientDeviceId?: string,       //   -> one row for that device
//   recipientGroupId?: string,        //   -> rejected until BE-5.7
// }
//
// Response: { success, duplicate, count, rows: [{ id, recipientDeviceId, pushed }], status? }
//   status (BE-5.5) = the message's four-state status; present when clientMessageId was sent.
//   pushed = a live socket was addressed. false is normal (recipient offline):
//   the row is durable and is delivered via /relay/poll.
// ──────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECIPIENT_DEVICES = 20;
const MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // placeholder until BE-5.6 confirms TAD retention

type Target = { deviceId: string; userId: string | null; ciphertext: Buffer };

router.post("/send", async (req: Request, res: Response) => {
  try {
    const authUserId = res.locals.auth!.sub;
    const authDeviceId = res.locals.auth!.deviceId;

    const {
      clientMessageId,
      recipients,
      recipientUserId,
      recipientDeviceId,
      recipientGroupId,
      ciphertext,
      messageType,
    } = req.body as {
      clientMessageId?: string;
      recipients?: Array<{ deviceId?: string; ciphertext?: string }>;
      recipientUserId?: string;
      recipientDeviceId?: string;
      recipientGroupId?: string;
      ciphertext?: string;
      messageType?: string;
    };

    if (clientMessageId !== undefined && (typeof clientMessageId !== "string" || !UUID_RE.test(clientMessageId))) {
      res.status(400).json({ error: "INVALID_CLIENT_MESSAGE_ID" });
      return;
    }

    const msgType = messageType ?? "text";
    if (!MESSAGE_TYPES.has(msgType)) {
      res.status(400).json({ error: "INVALID_MESSAGE_TYPE" });
      return;
    }

    // Exactly one addressing mode.
    const modes = [recipients, recipientUserId, recipientDeviceId, recipientGroupId].filter(
      (v) => v !== undefined && v !== null && v !== "",
    ).length;
    if (modes !== 1) {
      res.status(400).json({
        error: "Provide exactly one of recipients, recipientUserId, recipientDeviceId, recipientGroupId",
      });
      return;
    }

    const db = getDb();

    // ── Sender device must still be live. The access token stays valid for up to
    //    1h after a revoke (REST does not re-check the session), so check the row. ──
    const [senderDevice] = await db
      .select({ isActive: devices.isActive, revokedAt: devices.revokedAt })
      .from(devices)
      .where(and(eq(devices.id, authDeviceId), eq(devices.userId, authUserId)))
      .limit(1);
    if (!senderDevice || !senderDevice.isActive || senderDevice.revokedAt !== null) {
      res.status(403).json({ error: "SENDER_DEVICE_REVOKED" });
      return;
    }

    // Group sends were unreachable before (the exactly-one rule above conflicts with
    // the group row needing a relay device) and real fan-out is BE-5.7. Reject explicitly.
    if (recipientGroupId) {
      res.status(400).json({ error: "GROUP_SEND_NOT_IMPLEMENTED", message: "Group fan-out is BE-5.7" });
      return;
    }

    // ── Build the list of (device, ciphertext) targets ──
    let targets: Target[] = [];
    let targetUserId: string | null = null;

    if (recipients !== undefined) {
      if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > MAX_RECIPIENT_DEVICES) {
        res.status(400).json({ error: `recipients must be 1..${MAX_RECIPIENT_DEVICES} entries` });
        return;
      }
      const seen = new Set<string>();
      for (const r of recipients) {
        if (!r || typeof r.deviceId !== "string" || !UUID_RE.test(r.deviceId) || !isValidHexCiphertext(r.ciphertext)) {
          res.status(400).json({ error: "each recipient needs deviceId (uuid) and hex ciphertext" });
          return;
        }
        if (seen.has(r.deviceId)) {
          res.status(400).json({ error: "DUPLICATE_RECIPIENT_DEVICE" });
          return;
        }
        seen.add(r.deviceId);
        if (r.deviceId === authDeviceId) {
          res.status(400).json({ error: "CANNOT_SEND_TO_OWN_DEVICE" });
          return;
        }
      }
      const rows = await db
        .select({ id: devices.id, userId: devices.userId })
        .from(devices)
        .where(
          and(
            inArray(devices.id, recipients.map((r) => r.deviceId!)),
            eq(devices.isActive, true),
            isNull(devices.revokedAt),
          ),
        );
      if (rows.length !== recipients.length) {
        res.status(404).json({ error: "RECIPIENT_DEVICE_NOT_FOUND" });
        return;
      }
      const owners = new Set(rows.map((r) => r.userId));
      if (owners.size !== 1) {
        res.status(400).json({ error: "RECIPIENT_DEVICES_MUST_BELONG_TO_ONE_USER" });
        return;
      }
      targetUserId = rows[0]!.userId;
      targets = recipients.map((r) => ({
        deviceId: r.deviceId!,
        userId: targetUserId,
        ciphertext: Buffer.from(r.ciphertext!, "hex"),
      }));
    } else {
      if (!isValidHexCiphertext(ciphertext)) {
        res.status(400).json({ error: "ciphertext must be non-empty hex (even length, <= 200000 chars)" });
        return;
      }
      const blob = Buffer.from(ciphertext, "hex");

      if (recipientUserId) {
        const devList = await db
          .select({ id: devices.id })
          .from(devices)
          .where(
            and(eq(devices.userId, recipientUserId), eq(devices.isActive, true), isNull(devices.revokedAt)),
          );
        if (devList.length === 0) {
          res.status(404).json({ error: "Recipient has no active devices" });
          return;
        }
        targetUserId = recipientUserId;
        targets = devList.map((d) => ({ deviceId: d.id, userId: recipientUserId, ciphertext: blob }));
      } else if (recipientDeviceId) {
        // The recipient_exactly_one CHECK is user-XOR-group, so a device-addressed
        // 1:1 row MUST carry the device owner's user id (previously this path
        // inserted recipient_user_id = NULL and the CHECK rejected it).
        const [dev] = await db
          .select({ userId: devices.userId })
          .from(devices)
          .where(
            and(eq(devices.id, recipientDeviceId), eq(devices.isActive, true), isNull(devices.revokedAt)),
          )
          .limit(1);
        if (!dev) {
          res.status(404).json({ error: "RECIPIENT_DEVICE_NOT_FOUND" });
          return;
        }
        targetUserId = dev.userId;
        targets = [{ deviceId: recipientDeviceId, userId: dev.userId, ciphertext: blob }];
      } else {
        res.status(400).json({ error: "recipientDeviceId is required" });
        return;
      }
    }

    // ── DB-2.4: bidirectional block enforcement before insert ──
    if (targetUserId) {
      const senderHash = await resolvePhoneHashForUser(authUserId, db);
      const recipientHash = await resolvePhoneHashForUser(targetUserId, db);
      if (senderHash && recipientHash && (await hasBlockBetween(senderHash, recipientHash, db))) {
        res.status(403).json({ error: "BLOCKED", message: "Messaging between these two users is blocked" });
        return;
      }
    }

    // ── Idempotency: a retried send returns the original rows, inserts nothing, pushes nothing. ──
    const findExisting = () =>
      db
        .select({ id: pendingMessages.id, recipientDeviceId: pendingMessages.recipientDeviceId })
        .from(pendingMessages)
        .where(
          and(
            eq(pendingMessages.senderDeviceId, authDeviceId),
            eq(pendingMessages.clientMessageId, clientMessageId!),
            inArray(pendingMessages.recipientDeviceId, targets.map((t) => t.deviceId)),
          ),
        );

    if (clientMessageId) {
      // BE-5.5: the status row outlives the pending_messages rows (those are deleted on
      // delivery), so it is the authority on "was this already sent?". Without it a retry
      // after delivery would re-insert the message and the recipient would get it twice.
      const prior = await getStatus(db, authDeviceId, clientMessageId);
      if (prior) {
        // PRD 8.2: retrying a failed message moves it back to sent.
        const status = (await resetFailedToSent(db, authDeviceId, clientMessageId)) ?? prior;
        const existing = await findExisting();
        res.json({
          success: true,
          duplicate: true,
          count: existing.length,
          rows: existing.map((r) => ({ ...r, pushed: false })),
          status: toStatusEvent(status),
        });
        return;
      }
      const existing = await findExisting();
      if (existing.length === targets.length) {
        res.json({
          success: true,
          duplicate: true,
          count: existing.length,
          rows: existing.map((r) => ({ ...r, pushed: false })),
        });
        return;
      }
    }

    const expiresAt = new Date(Date.now() + MESSAGE_TTL_MS);
    let inserted;
    try {
      // One transaction: the queue rows and the `sent` status row exist together or not at all.
      ({ inserted } = await db.transaction(async (tx) => {
        const rows = await tx
          .insert(pendingMessages)
          .values(
            targets.map((t) => ({
              senderDeviceId: authDeviceId,
              recipientDeviceId: t.deviceId,
              recipientUserId: t.userId,
              recipientGroupId: null,
              ciphertext: t.ciphertext,
              messageType: msgType,
              sizeBytes: t.ciphertext.length,
              expiresAt,
              clientMessageId: clientMessageId ?? null,
            })),
          )
          .returning({
            id: pendingMessages.id,
            recipientDeviceId: pendingMessages.recipientDeviceId,
            recipientUserId: pendingMessages.recipientUserId,
            createdAt: pendingMessages.createdAt,
          });
        if (clientMessageId && targetUserId) {
          await recordSent(tx, {
            senderDeviceId: authDeviceId,
            senderUserId: authUserId,
            clientMessageId,
            recipientUserId: targetUserId,
          });
        }
        return { inserted: rows };
      }));
    } catch (err) {
      // Two concurrent retries of the same clientMessageId: the unique index
      // (migration 018) rejects the loser; treat it as a duplicate.
      const code = (err as { code?: string; cause?: { code?: string } }).code
        ?? (err as { cause?: { code?: string } }).cause?.code;
      if (clientMessageId && code === "23505") {
        const existing = await findExisting();
        const prior = await getStatus(db, authDeviceId, clientMessageId);
        res.json({
          success: true,
          duplicate: true,
          count: existing.length,
          rows: existing.map((r) => ({ ...r, pushed: false })),
          ...(prior ? { status: toStatusEvent(prior) } : {}),
        });
        return;
      }
      throw err;
    }

    // ── Relay: durable first, then best-effort real-time push. ──
    const rows = inserted.map((row, i) => {
      let pushed = false;
      if (row.recipientUserId) {
        pushed = pushToDevice(row.recipientUserId, row.recipientDeviceId, "message", {
          id: row.id,
          senderDeviceId: authDeviceId,
          ciphertext: targets[i]!.ciphertext.toString("hex"),
          messageType: msgType,
          sizeBytes: targets[i]!.ciphertext.length,
          clientMessageId: clientMessageId ?? null,
          createdAt: row.createdAt,
        });
      }
      return { id: row.id, recipientDeviceId: row.recipientDeviceId, pushed };
    });

    // PERM-2.5: a device with no live socket is backgrounded or closed, so it
    // gets an OS push instead. Fire-and-forget; never blocks or fails the send.
    const offline = rows.filter((r) => !r.pushed && r.recipientDeviceId).map((r) => r.recipientDeviceId!);
    if (offline.length > 0) {
      void db
        .select({ token: pushTokens.token })
        .from(pushTokens)
        .where(inArray(pushTokens.deviceId, offline))
        .then((t) => sendExpoPush(t.map((x) => x.token)))
        .catch(() => console.error("relay push lookup failed"));
    }

    res.json({ success: true, duplicate: false, count: rows.length, rows });
  } catch {
    console.error("POST /relay/send error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────
// POST /relay/poll
// Body: { deviceId?: string }  // defaults to the auth deviceId
// Returns all undelivered messages addressed to this device.
// ──────────────────────────────────────────────────
router.post("/poll", async (req: Request, res: Response) => {
  try {
    const authUserId = res.locals.auth!.sub;
    const authDeviceId = res.locals.auth!.deviceId;
    const { deviceId } = req.body as { deviceId?: string };
    const targetDevice = deviceId || authDeviceId;

    const db = getDb();
    const senderHash = await resolvePhoneHashForUser(authUserId, db);
    const blockedPartners =
      senderHash ? await blockedPartnerHashes(senderHash, db) : new Set<string>();

    const rows = await db
      .select({
        id: pendingMessages.id,
        senderDeviceId: pendingMessages.senderDeviceId,
        ciphertext: pendingMessages.ciphertext,
        messageType: pendingMessages.messageType,
        sizeBytes: pendingMessages.sizeBytes,
        createdAt: pendingMessages.createdAt,
        expiresAt: pendingMessages.expiresAt,
        clientMessageId: pendingMessages.clientMessageId,
        senderPhone: users.phoneNumber,
      })
      .from(pendingMessages)
      .leftJoin(devices, eq(pendingMessages.senderDeviceId, devices.id))
      .leftJoin(users, eq(devices.userId, users.id))
      .where(
        and(
          eq(pendingMessages.recipientDeviceId, targetDevice),
          isNull(pendingMessages.deliveredAt),
          gt(pendingMessages.expiresAt, new Date()),
          eq(pendingMessages.recipientUserId, authUserId),
        ),
      )
      .orderBy(pendingMessages.createdAt);

    // DB-2.4: drop messages whose sender is a blocked partner (either direction),
    // so a blocked user's messages are never delivered to the recipient.
    const visible = rows.filter((r) => {
      if (!r.senderPhone) return true;
      return !blockedPartners.has(phoneHash(r.senderPhone));
    });

    res.json({
      messages: visible.map((r) => ({
        id: r.id,
        senderDeviceId: r.senderDeviceId,
        ciphertext: r.ciphertext ? r.ciphertext.toString("hex") : null,
        messageType: r.messageType,
        sizeBytes: r.sizeBytes,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        clientMessageId: r.clientMessageId,
      })),
    });

  } catch {

    console.error("POST /relay/poll error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────
// POST /relay/ack
// Body: { messageId: string }
// The RECIPIENT DEVICE confirms receipt. Scoped to the authenticated
// device, not just the user: acking on behalf of a sibling device would
// let the cleanup job delete a message that device never received.
// Idempotent: acking an already-acked message succeeds.
// ──────────────────────────────────────────────────
router.post("/ack", async (req: Request, res: Response) => {
  try {
    const authUserId = res.locals.auth!.sub;
    const authDeviceId = res.locals.auth!.deviceId;
    const { messageId } = req.body as { messageId?: string };

    if (typeof messageId !== "string" || !UUID_RE.test(messageId)) {
      res.status(400).json({ error: "messageId is required" });
      return;
    }

    const db = getDb();
    const mine = and(
      eq(pendingMessages.id, messageId),
      eq(pendingMessages.recipientDeviceId, authDeviceId),
      isAddressedToUser(authUserId),
    );

    // BE-5.5: mark the queue row delivered AND escalate the sender's status in one transaction,
    // so a crash between the two can never leave the sender stuck on `sent` after the queue
    // row has been purged.
    const { updated, status } = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(pendingMessages)
        .set({ deliveredAt: new Date() })
        .where(and(mine, isNull(pendingMessages.deliveredAt)))
        .returning({
          id: pendingMessages.id,
          deliveredAt: pendingMessages.deliveredAt,
          senderDeviceId: pendingMessages.senderDeviceId,
          clientMessageId: pendingMessages.clientMessageId,
        });
      const changed =
        row && row.clientMessageId
          ? await escalate(tx, {
              senderDeviceId: row.senderDeviceId,
              clientMessageId: row.clientMessageId,
              to: "delivered",
            })
          : null;
      return { updated: row, status: changed };
    });

    if (updated) {
      // After commit: tell the sender live. No-op if a sibling recipient device already
      // escalated (status === null) or the sender is offline (they catch up via /status/sync).
      if (status) pushStatusToSender(status);
      res.json({ success: true, messageId: updated.id, deliveredAt: updated.deliveredAt });
      return;
    }

    const [already] = await db
      .select({ id: pendingMessages.id, deliveredAt: pendingMessages.deliveredAt })
      .from(pendingMessages)
      .where(and(mine, isNotNull(pendingMessages.deliveredAt)))
      .limit(1);

    if (already) {
      res.json({ success: true, messageId: already.id, deliveredAt: already.deliveredAt, alreadyAcked: true });
      return;
    }

    res.status(404).json({ error: "Message not found" });
  } catch {
    console.error("POST /relay/ack error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
