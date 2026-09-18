/**
 * DB-2.2 — Message relay routes.
 *
 * Used for functional verification of the message_relay table:
 *  - POST /relay/send  — create a message_relay row for a recipient
 *  - POST /relay/poll   — fetch undelivered messages for a device
 *  - POST /relay/ack    — mark a message as delivered
 *
 * The per-device model is: for a recipient with N devices, the sender
 * creates N message_relay rows — one per recipient_device_id.
 */

import { Router, type Request, type Response } from "express";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import { devices } from "../db/devices-schema.js";
import { users } from "../db/users-schema.js";
import { blocks } from "../db/blocks-schema.js";
import { messageRelay } from "../db/message-relay-schema.js";
import { phoneHash } from "../utils/phone-hash.js";

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
async function resolvePhoneHashForUser(
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

/** Resolve the recipient's phone hash from a userId or deviceId (group = null). */
async function resolveRecipientPhoneHash(
  recipientUserId: string | undefined,
  recipientDeviceId: string | undefined,
  db: ReturnType<typeof getDb>,
): Promise<string | null> {
  if (recipientUserId) {
    return resolvePhoneHashForUser(recipientUserId, db);
  }
  if (recipientDeviceId) {
    const [row] = await db
      .select({ phoneNumber: users.phoneNumber })
      .from(devices)
      .innerJoin(users, eq(devices.userId, users.id))
      .where(eq(devices.id, recipientDeviceId))
      .limit(1);
    return row ? phoneHash(row.phoneNumber) : null;
  }
  return null;
}

/** True when a block exists between two hashes in EITHER direction. */
async function hasBlockBetween(
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
async function blockedPartnerHashes(
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
    eq(messageRelay.recipientUserId, authUserId),
    sql`EXISTS (SELECT 1 FROM devices WHERE devices.id = ${messageRelay.recipientDeviceId} AND devices.user_id = ${authUserId})`,
  )!;
}

// ──────────────────────────────────────────────────
// POST /relay/send
// Body: {
//   recipientUserId?: string,
//   recipientDeviceId?: string,
//   recipientGroupId?: string,
//   ciphertext: string,   // hex-encoded ciphertext
//   messageType?: string,
// }
// If only recipientUserId is given, one row is created per device of
// that user. Otherwise a single row is created for the given device/group.
// ──────────────────────────────────────────────────
router.post("/send", async (req: Request, res: Response) => {
  try {
    const authUserId = res.locals.auth!.sub;
    const authDeviceId = res.locals.auth!.deviceId;

    const {
      recipientUserId,
      recipientDeviceId,
      recipientGroupId,
      ciphertext,
      messageType,
    } = req.body as {
      recipientUserId?: string;
      recipientDeviceId?: string;
      recipientGroupId?: string;
      ciphertext?: string;
      messageType?: string;
    };

    if (!isValidHexCiphertext(ciphertext)) {
      res.status(400).json({ error: "ciphertext must be non-empty hex (even length, <= 200000 chars)" });
      return;
    }

    const msgType = messageType ?? "text";
    if (!MESSAGE_TYPES.has(msgType)) {
      res.status(400).json({ error: "INVALID_MESSAGE_TYPE" });
      return;
    }

    // Exactly one recipient type must be specified.
    const provided = [recipientUserId, recipientDeviceId, recipientGroupId].filter(Boolean).length;
    if (provided !== 1) {
      res.status(400).json({ error: "Provide exactly one of recipientUserId, recipientDeviceId, recipientGroupId" });
      return;
    }

    const db = getDb();

    // ── DB-2.4: bidirectional block enforcement before insert ──
    const senderHash = await resolvePhoneHashForUser(authUserId, db);
    const recipientHash = await resolveRecipientPhoneHash(recipientUserId, recipientDeviceId, db);
    if (senderHash && recipientHash && (await hasBlockBetween(senderHash, recipientHash, db))) {
      res.status(403).json({ error: "BLOCKED", message: "Messaging between these two users is blocked" });
      return;
    }

    const ciphertextBytes = Buffer.from(ciphertext, "hex");
    const sizeBytes = ciphertextBytes.length;

    // If recipientUserId is given, fan out one row per device.
    if (recipientUserId) {
      const devList = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.userId, recipientUserId), eq(devices.isActive, true)));

      if (devList.length === 0) {
        res.status(404).json({ error: "Recipient has no active devices" });
        return;
      }

      const rows = await db
        .insert(messageRelay)
        .values(
          devList.map((d) => ({
            senderDeviceId: authDeviceId,
            recipientDeviceId: d.id,
            recipientUserId,
            ciphertext: ciphertextBytes,
            messageType: msgType,
            sizeBytes,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          })),
        )
        .returning({ id: messageRelay.id, recipientDeviceId: messageRelay.recipientDeviceId });

      res.json({ success: true, count: rows.length, rows });
      return;
    }

    // Single-device or group recipient. recipientDeviceId is required
    // by the schema (NOT NULL); for a group message it targets the
    // sender's chosen relay device.
    if (!recipientDeviceId) {
      res.status(400).json({ error: "recipientDeviceId is required" });
      return;
    }

    const [row] = await db
      .insert(messageRelay)
      .values({
        senderDeviceId: authDeviceId,
        recipientDeviceId,
        recipientUserId: null,
        recipientGroupId: recipientGroupId ?? null,
        ciphertext: ciphertextBytes,
        messageType: msgType,
        sizeBytes,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .returning({
        id: messageRelay.id,
        recipientDeviceId: messageRelay.recipientDeviceId,
        recipientUserId: messageRelay.recipientUserId,
        recipientGroupId: messageRelay.recipientGroupId,
      });

    res.json({ success: true, count: 1, rows: [row] });
  } catch (err) {
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
        id: messageRelay.id,
        senderDeviceId: messageRelay.senderDeviceId,
        ciphertext: messageRelay.ciphertext,
        messageType: messageRelay.messageType,
        sizeBytes: messageRelay.sizeBytes,
        createdAt: messageRelay.createdAt,
        expiresAt: messageRelay.expiresAt,
        senderPhone: users.phoneNumber,
      })
      .from(messageRelay)
      .leftJoin(devices, eq(messageRelay.senderDeviceId, devices.id))
      .leftJoin(users, eq(devices.userId, users.id))
      .where(
        and(
          eq(messageRelay.recipientDeviceId, targetDevice),
          isNull(messageRelay.deliveredAt),
          eq(messageRelay.recipientUserId, authUserId),
        ),
      )
      .orderBy(messageRelay.createdAt);

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
      })),
    });
  } catch (err) {
    console.error("POST /relay/poll error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────
// POST /relay/ack
// Body: { messageId: string }
// Marks a relayed message as delivered.
// ──────────────────────────────────────────────────
router.post("/ack", async (req: Request, res: Response) => {
  try {
    const authUserId = res.locals.auth!.sub;
    const { messageId } = req.body as { messageId?: string };

    if (typeof messageId !== "string" || !messageId) {
      res.status(400).json({ error: "messageId is required" });
      return;
    }

    const db = getDb();
    const [updated] = await db
      .update(messageRelay)
      .set({ deliveredAt: new Date() })
      .where(
        and(
          eq(messageRelay.id, messageId),
          isAddressedToUser(authUserId),
        ),
      )
      .returning({ id: messageRelay.id, deliveredAt: messageRelay.deliveredAt });

    if (!updated) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    res.json({ success: true, messageId: updated.id, deliveredAt: updated.deliveredAt });
  } catch (err) {
    console.error("POST /relay/ack error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;