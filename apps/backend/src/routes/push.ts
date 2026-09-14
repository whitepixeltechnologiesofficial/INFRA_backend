/**
 * Push routes — register / revoke a device push token.
 *
 * All routes require a valid JWT access token (requireAuth middleware). The
 * userId and deviceId are derived from the token claims — never from req.body —
 * preventing spoofing another user's device registration (OWASP API #1).
 *
 *   POST /push/register — upsert this device's push token (Scenario 3.4 grant
 *     path). Rejects any token that is not Expo-push-token-shaped.
 *   POST /push/revoke   — forget this device's push token (e.g. on logout).
 */

import { Router, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { pushDevices } from "../db/push-devices-schema.js";
import { requireAuth } from "../middleware/auth.js";

const router: Router = Router();

router.use(requireAuth);

// Reject anything that can't be an Expo push token (APNs/FCM-backed).
const TOKEN_SHAPE = /ExponentPushToken\[[A-Za-z0-9\-_~]{6,}\]/;

// ──────────────────────────────────────────────────
// POST /push/register
// ──────────────────────────────────────────────────
router.post("/register", async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth!;
    const userId = auth.sub;
    const deviceId = auth.deviceId;

    const { token, platform } = req.body as { token?: string; platform?: string };

    if (!token || typeof token !== "string" || !TOKEN_SHAPE.test(token)) {
      res.status(400).json({ error: "INVALID_TOKEN" });
      return;
    }

    const safePlatform = platform === "ios" ? "ios" : platform === "android" ? "android" : "unknown";
    const now = new Date();

    const db = getDb();
    await db
      .insert(pushDevices)
      .values({ userId, deviceId, token, platform: safePlatform, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [pushDevices.userId, pushDevices.deviceId],
        set: { token, platform: safePlatform, updatedAt: now },
      });

    res.json({ success: true, registered: true, token });
  } catch (_err) {
    console.error("POST /push/register error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────
// POST /push/revoke
// ──────────────────────────────────────────────────
router.post("/revoke", async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth!;
    const userId = auth.sub;
    const deviceId = auth.deviceId;

    const db = getDb();
    const deleted = await db
      .delete(pushDevices)
      .where(and(eq(pushDevices.userId, userId), eq(pushDevices.deviceId, deviceId)))
      .returning({ id: pushDevices.id });

    res.json({ success: true, revoked: deleted.length > 0 });
  } catch (_err) {
    console.error("POST /push/revoke error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
