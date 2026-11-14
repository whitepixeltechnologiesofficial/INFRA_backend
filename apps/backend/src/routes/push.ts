/**
 * PERM-2.5 — Push token registration.
 *
 * POST /push/register   { token, platform }  — bind this device's Expo push token
 * POST /push/unregister { }                  — forget this device's token
 *
 * The user and device come from the verified JWT, never the body, so a
 * caller can only register a token for its own device.
 */

import { Router, type Request, type Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import { devices } from "../db/devices-schema.js";
import { pushTokens } from "../db/push-tokens-schema.js";
import { isExpoPushToken } from "../push/expo-push.js";

const router: Router = Router();

router.use(requireAuth);

const PLATFORMS = new Set(["ios", "android"]);

router.post("/register", async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth!.sub;
    const deviceId = res.locals.auth!.deviceId;
    const { token, platform } = req.body as { token?: unknown; platform?: unknown };

    if (!isExpoPushToken(token)) {
      res.status(400).json({ error: "INVALID_TOKEN" });
      return;
    }
    if (typeof platform !== "string" || !PLATFORMS.has(platform)) {
      res.status(400).json({ error: "INVALID_PLATFORM" });
      return;
    }

    const db = getDb();
    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId), eq(devices.isActive, true), isNull(devices.revokedAt)))
      .limit(1);
    if (!device) {
      res.status(403).json({ error: "DEVICE_NOT_ACTIVE" });
      return;
    }

    await db.transaction(async (tx) => {
      await tx.delete(pushTokens).where(eq(pushTokens.token, token));
      await tx
        .insert(pushTokens)
        .values({ userId, deviceId, token, platform })
        .onConflictDoUpdate({
          target: pushTokens.deviceId,
          set: { token, platform, userId, updatedAt: new Date() },
        });
    });

    res.json({ success: true });
  } catch {
    console.error("POST /push/register error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/unregister", async (_req: Request, res: Response) => {
  try {
    const deviceId = res.locals.auth!.deviceId;
    await getDb().delete(pushTokens).where(eq(pushTokens.deviceId, deviceId));
    res.json({ success: true });
  } catch {
    console.error("POST /push/unregister error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
