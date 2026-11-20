/**
 * BE-5.7 — Group message fan-out.
 *
 * POST /relay/send with `recipientGroupId` lands here (see routes/relay.ts).
 *
 * The server stays a BLIND relay: a group message is encrypted ONCE by the
 * sender (Sender Key, @wpt/crypto) and the same opaque ciphertext is queued
 * for every device of every current member, one pending_messages row per
 * recipient device (the existing per-device queue model). Sender Key
 * distribution and rotation on member departure happen on the clients over
 * the 1:1 sessions and are not handled here.
 *
 * Rules enforced here (PRD 5.7 / section 11 / 12):
 *  - the sender must currently be a member (non-members get the same 404 as
 *    an unknown group, so group ids cannot be probed)
 *  - who_can_send = admins_only: only owner/admin may send
 *  - a group never exceeds 70 members (GROUP_MEMBER_CAP). Adding is capped by
 *    migration 020's trigger; an over-cap group found here is refused rather
 *    than silently truncated
 *  - blocking does NOT apply inside shared groups (PRD 19.8), so there is no
 *    block check on this path, and poll/drain do not filter group rows
 *  - the sender's own user is excluded (same as 1:1: no copy to own devices)
 *  - members with no active device are skipped and reported, not failed
 *
 * Status: one `sent` message_status row per recipient MEMBER, created in the
 * same transaction as the queue rows. Each member's ack/read then moves only
 * their own row, which is the per-recipient tracking.
 *
 * Queue rows carry recipient_group_id with recipient_user_id NULL (the
 * pending_messages user-XOR-group CHECK), so delivery re-checks membership:
 * a member removed after the send never receives the queued copy.
 */

import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Response } from "express";
import type { getDb } from "../db/index.js";
import { devices } from "../db/devices-schema.js";
import { groups, groupMembers } from "../db/groups-schema.js";
import { pendingMessages } from "../db/pending-messages-schema.js";
import { getStatuses, recordSentMany, resetFailedToSent, toStatusEvent } from "../db/message-status.js";
import { pushToDevice } from "../ws/socket-registry.js";

/** PRD 5.7 / 12.8. Mirrored by the trigger in migration 020. */
export const GROUP_MEMBER_CAP = 70;

/**
 * SQL condition for queue reads (poll + reconnect drain): a group row is only
 * deliverable while the device's owner is STILL a member of that group.
 * 1:1 rows (recipient_group_id IS NULL) are unaffected.
 */
export function groupRowStillDeliverable(): SQL {
  return sql`(${pendingMessages.recipientGroupId} IS NULL OR EXISTS (
    SELECT 1 FROM group_members gm
      JOIN devices gd ON gd.user_id = gm.user_id
     WHERE gm.group_id = ${pendingMessages.recipientGroupId}
       AND gd.id = ${pendingMessages.recipientDeviceId}
  ))`;
}

type Db = ReturnType<typeof getDb>;

export async function handleGroupSend(args: {
  res: Response;
  db: Db;
  authUserId: string;
  authDeviceId: string;
  groupId: string;
  clientMessageId: string;
  ciphertext: Buffer;
  messageType: string;
  expiresAt: Date;
}): Promise<void> {
  const { res, db, authUserId, authDeviceId, groupId, clientMessageId, ciphertext, messageType, expiresAt } = args;

  const [group] = await db
    .select({ whoCanSend: groups.whoCanSend })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1);
  const members = group
    ? await db
        .select({ userId: groupMembers.userId, role: groupMembers.role })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, groupId))
    : [];
  const me = members.find((m) => m.userId === authUserId);

  if (!group || !me) {
    res.status(404).json({ error: "GROUP_NOT_FOUND" });
    return;
  }
  if (group.whoCanSend === "admins_only" && me.role === "member") {
    res.status(403).json({ error: "ADMINS_ONLY", message: "Only owners and admins can send in this group" });
    return;
  }
  if (members.length > GROUP_MEMBER_CAP) {
    res.status(409).json({ error: "GROUP_OVER_CAP", cap: GROUP_MEMBER_CAP, members: members.length });
    return;
  }

  const recipientMembers = members.filter((m) => m.userId !== authUserId);
  if (recipientMembers.length === 0) {
    res.status(400).json({ error: "GROUP_HAS_NO_OTHER_MEMBERS" });
    return;
  }

  const deviceRows = await db
    .select({ id: devices.id, userId: devices.userId })
    .from(devices)
    .where(
      and(
        inArray(devices.userId, recipientMembers.map((m) => m.userId)),
        eq(devices.isActive, true),
        isNull(devices.revokedAt),
      ),
    );
  if (deviceRows.length === 0) {
    res.status(409).json({ error: "GROUP_HAS_NO_ACTIVE_DEVICES" });
    return;
  }
  const userByDevice = new Map(deviceRows.map((d) => [d.id, d.userId]));
  const recipientUserIds = [...new Set(deviceRows.map((d) => d.userId))];
  const skippedMembers = recipientMembers.length - recipientUserIds.length;

  const findExisting = () =>
    db
      .select({ id: pendingMessages.id, recipientDeviceId: pendingMessages.recipientDeviceId })
      .from(pendingMessages)
      .where(
        and(
          eq(pendingMessages.senderDeviceId, authDeviceId),
          eq(pendingMessages.clientMessageId, clientMessageId),
          eq(pendingMessages.recipientGroupId, groupId),
        ),
      );

  const duplicateResponse = async () => {
    const existing = await findExisting();
    const statuses = await getStatuses(db, authDeviceId, clientMessageId);
    res.json({
      success: true,
      duplicate: true,
      groupId,
      recipientCount: statuses.length,
      count: existing.length,
      skippedMembers,
      rows: existing.map((r) => ({ ...r, pushed: false })),
      statuses: statuses.map(toStatusEvent),
    });
  };

  // ── Idempotency: a retried send re-inserts and re-pushes nothing. The status rows
  //    outlive the (deleted-on-delivery) queue rows, so they are the authority. ──
  const prior = await getStatuses(db, authDeviceId, clientMessageId);
  if (prior.length > 0) {
    // PRD 8.2: retrying a failed message moves it back to sent.
    await resetFailedToSent(db, authDeviceId, clientMessageId);
    await duplicateResponse();
    return;
  }

  let inserted;
  let statusRows;
  try {
    ({ inserted, statusRows } = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(pendingMessages)
        .values(
          deviceRows.map((d) => ({
            senderDeviceId: authDeviceId,
            recipientDeviceId: d.id,
            recipientUserId: null, // pending_messages CHECK: user XOR group
            recipientGroupId: groupId,
            ciphertext,
            messageType,
            sizeBytes: ciphertext.length,
            expiresAt,
            clientMessageId,
          })),
        )
        .returning({
          id: pendingMessages.id,
          recipientDeviceId: pendingMessages.recipientDeviceId,
          createdAt: pendingMessages.createdAt,
        });
      const status = await recordSentMany(tx, {
        senderDeviceId: authDeviceId,
        senderUserId: authUserId,
        clientMessageId,
        recipientUserIds,
      });
      return { inserted: rows, statusRows: status };
    }));
  } catch (err) {
    // Two concurrent retries of the same clientMessageId: the unique indexes reject the loser.
    const code =
      (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    if (code === "23505") {
      await duplicateResponse();
      return;
    }
    throw err;
  }

  // ── Durable first, then best-effort live push. pushed:false just means that device is offline:
  //    it gets the message on reconnect (BE-5.6 drain) or via /relay/poll. ──
  const rows = inserted.map((row) => {
    const memberUserId = userByDevice.get(row.recipientDeviceId);
    const pushed = memberUserId
      ? pushToDevice(memberUserId, row.recipientDeviceId, "message", {
          id: row.id,
          senderDeviceId: authDeviceId,
          groupId,
          ciphertext: ciphertext.toString("hex"),
          messageType,
          sizeBytes: ciphertext.length,
          clientMessageId,
          createdAt: row.createdAt,
        })
      : false;
    return { id: row.id, recipientDeviceId: row.recipientDeviceId, pushed };
  });

  res.json({
    success: true,
    duplicate: false,
    groupId,
    recipientCount: recipientUserIds.length,
    count: rows.length,
    skippedMembers,
    rows,
    statuses: statusRows.map(toStatusEvent),
  });
}
