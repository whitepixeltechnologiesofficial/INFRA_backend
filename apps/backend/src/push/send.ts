/**
 * sendNotification — fan out a push to a user's registered devices.
 *
 * Looks up every live push token for `userId` and sends the payload through the
 * currently selected provider (see provider.ts). Mirrors the socket registry's
 * `pushForceLogout` fan-out, but over the push provider instead of socket.io —
 * this is what reaches a device even when the app is fully backgrounded.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { pushDevices } from "../db/push-devices-schema.js";
import { selectPushProvider, type PushPayload, type SendResult } from "./provider.js";

export type NotificationFanoutResult = {
  total: number;
  delivered: number;
  failed: number;
  failures: { token: string; message: string }[];
};

/**
 * Send `payload` to every device the user has registered for push. Returns a
 * per-device breakdown so callers can surface partial failure (never silent).
 */
export async function sendNotification(
  userId: string,
  payload: PushPayload,
): Promise<NotificationFanoutResult> {
  const db = getDb();
  const rows = await db
    .select({ token: pushDevices.token })
    .from(pushDevices)
    .where(eq(pushDevices.userId, userId));

  const provider = selectPushProvider();

  const result: NotificationFanoutResult = { total: rows.length, delivered: 0, failed: 0, failures: [] };

  for (const { token } of rows) {
    const outcome: SendResult = await provider.send(token, payload);
    if (!outcome.ok) {
      result.failed += 1;
      result.failures.push({ token, message: outcome.message });
    } else {
      result.delivered += 1;
    }
  }

  return result;
}

/** Total registered device tokens for a user (debug/summary). */
export async function deviceCount(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ token: pushDevices.token })
    .from(pushDevices)
    .where(eq(pushDevices.userId, userId));
  return rows.length;
}
