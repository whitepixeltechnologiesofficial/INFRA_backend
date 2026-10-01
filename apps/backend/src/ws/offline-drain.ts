/**
 * BE-5.6 — Offline recipient queuing: reconnect drain.
 *
 * Queuing itself already exists (BE-5.4): POST /relay/send writes one
 * pending_messages row per recipient device whether or not that device has
 * a live socket, and BE-5.5 keeps the sender's status at `sent` while the
 * recipient is offline. What was missing is the "delivers automatically the
 * moment the recipient reconnects" half: until now a reconnecting device had
 * to know to call POST /relay/poll.
 *
 * On socket connect (app.ts) this pushes every undelivered, unexpired,
 * non-blocked row queued for that exact device, oldest first, as the same
 * `message` event a live push uses.
 *
 * Delivery is NOT marked here. The client still confirms with POST /relay/ack,
 * which stamps delivered_at and moves the sender's status to `delivered`
 * (BE-5.5). So a drop mid-drain loses nothing: unacked rows stay queued and
 * are pushed again on the next connect. Because of that (and because a message
 * sent during the drain is also live-pushed) the client MUST dedupe by `id`.
 *
 * Block enforcement mirrors /relay/poll (DB-2.4) via the same helpers.
 */

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Socket } from "socket.io";
import { getDb } from "../db/index.js";
import { devices } from "../db/devices-schema.js";
import { users } from "../db/users-schema.js";
import { pendingMessages } from "../db/pending-messages-schema.js";
import { phoneHash } from "../utils/phone-hash.js";
import { blockedPartnerHashes, resolvePhoneHashForUser } from "../routes/relay.js";

// PLACEHOLDERS until the TAD offline-handling spec is confirmed.
export const DRAIN_BATCH_SIZE = 50;
export const MAX_DRAIN_PER_CONNECT = 1000;

/** Sockets currently draining — one drain per socket at a time. */
const draining = new Set<string>();

type Cursor = { createdAtRaw: string; id: string };

/**
 * Push this device's queued messages to `socket`. Returns how many were pushed.
 * If MAX_DRAIN_PER_CONNECT is hit, a `queue_more` event tells the client to
 * continue via POST /relay/poll. Safe to call more than once; never throws
 * for a socket that disconnects part-way (the drain just stops).
 */
export async function drainQueuedMessages(
  socket: Socket,
  userId: string,
  deviceId: string,
): Promise<number> {
  if (draining.has(socket.id)) return 0;
  draining.add(socket.id);

  try {
    const db = getDb();
    const selfHash = await resolvePhoneHashForUser(userId, db);
    const blockedPartners = selfHash ? await blockedPartnerHashes(selfHash, db) : new Set<string>();

    let cursor: Cursor | null = null;
    let pushed = 0;
    let capped = false;

    while (socket.connected) {
      const conds = [
        eq(pendingMessages.recipientDeviceId, deviceId),
        eq(pendingMessages.recipientUserId, userId),
        isNull(pendingMessages.deliveredAt),
        gt(pendingMessages.expiresAt, new Date()),
      ];
      // Keyset pagination on (created_at, id). The cursor carries created_at as the
      // DB's own text so microsecond precision survives (a JS Date would truncate to
      // ms and re-select the row it came from); id breaks ties between equal timestamps.
      if (cursor) {
        conds.push(
          sql`(${pendingMessages.createdAt}, ${pendingMessages.id}) > (${cursor.createdAtRaw}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      const rows = await db
        .select({
          id: pendingMessages.id,
          senderDeviceId: pendingMessages.senderDeviceId,
          ciphertext: pendingMessages.ciphertext,
          messageType: pendingMessages.messageType,
          sizeBytes: pendingMessages.sizeBytes,
          createdAt: pendingMessages.createdAt,
          createdAtRaw: sql<string>`${pendingMessages.createdAt}::text`.as("created_at_raw"),
          clientMessageId: pendingMessages.clientMessageId,
          senderPhone: users.phoneNumber,
        })
        .from(pendingMessages)
        .leftJoin(devices, eq(pendingMessages.senderDeviceId, devices.id))
        .leftJoin(users, eq(devices.userId, users.id))
        .where(and(...conds))
        .orderBy(pendingMessages.createdAt, pendingMessages.id)
        .limit(DRAIN_BATCH_SIZE);

      if (rows.length === 0) break;

      for (const r of rows) {
        // DB-2.4: never hand a blocked partner's message to the recipient (same rule as /relay/poll).
        if (r.senderPhone && blockedPartners.has(phoneHash(r.senderPhone))) continue;
        if (!socket.connected) break;
        // Same payload shape as the live push in POST /relay/send.
        socket.emit("message", {
          id: r.id,
          senderDeviceId: r.senderDeviceId,
          ciphertext: r.ciphertext ? r.ciphertext.toString("hex") : null,
          messageType: r.messageType,
          sizeBytes: r.sizeBytes,
          clientMessageId: r.clientMessageId,
          createdAt: r.createdAt,
        });
        pushed++;
      }

      const last = rows[rows.length - 1]!;
      cursor = { createdAtRaw: last.createdAtRaw, id: last.id };

      if (rows.length < DRAIN_BATCH_SIZE) break;
      if (pushed >= MAX_DRAIN_PER_CONNECT) {
        capped = true;
        break;
      }
      // Yield so one big backlog cannot monopolise the event loop.
      await new Promise<void>((r) => setImmediate(r));
    }

    if (capped && socket.connected) socket.emit("queue_more");
    if (pushed > 0) console.log(`BE-5.6 drained ${pushed} queued message(s) to a reconnecting device`);
    return pushed;
  } finally {
    draining.delete(socket.id);
  }
}
