/**
 * BE-5.2: Prekey distribution routes (X3DH).
 *
 *   POST /prekeys/upload            publish identity key, signing key, signed prekey and/or one-time prekeys
 *   GET  /prekeys/count             how many unused one-time prekeys I have left
 *   GET  /prekeys/bundle/:deviceId  fetch a device's prekey bundle
 *
 * FALLBACK (documented edge case): if a device has no one-time prekeys
 * left, the bundle is still returned WITHOUT oneTimePreKey. x3dh.ts
 * already handles this (dh4 is skipped), so key exchange still works,
 * with slightly weaker replay protection. It never fails outright.
 *
 * IDENTITY KEY: onboarding stores a placeholder ("pf_<deviceId>") in
 * devices.identity_public_key. A device uploads its real identity key
 * once; after that it can never be changed. No bundle is served while
 * the placeholder is still in place.
 *
 * All keys are base64. X25519 and Ed25519 public keys are 32 bytes,
 * Ed25519 signatures are 64 bytes.
 */

import { Router, type Request, type Response } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { devices } from "../db/devices-schema.js";
import { signedPrekeys, oneTimePrekeys } from "../db/prekeys-schema.js";
import { requireAuth } from "../middleware/auth.js";

const router: Router = Router();
router.use(requireAuth);

// PLACEHOLDERS: confirm against the TAD prekey spec.
export const MAX_ONE_TIME_PREKEYS_PER_UPLOAD = 100;
export const LOW_PREKEY_THRESHOLD = 10;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Onboarding stores "pf_<deviceId>" until the device uploads its real identity key. */
function isPlaceholderIdentityKey(k: string): boolean {
  return k.startsWith("pf_");
}

/** True if v is canonical base64 that decodes to exactly `bytes` bytes. */
function isBase64OfLength(v: unknown, bytes: number): v is string {
  if (typeof v !== "string") return false;
  const buf = Buffer.from(v, "base64");
  return buf.length === bytes && buf.toString("base64") === v;
}

/** The caller's own active device, or null. */
async function resolveOwnDevice(userId: string, deviceId: string) {
  if (!UUID_RE.test(deviceId)) return null;
  const db = getDb();
  const [row] = await db
    .select({
      id: devices.id,
      identityPublicKey: devices.identityPublicKey,
      signingPublicKey: devices.signingPublicKey,
    })
    .from(devices)
    .where(
      and(
        eq(devices.id, deviceId),
        eq(devices.userId, userId),
        eq(devices.isActive, true),
        isNull(devices.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function countUnclaimed(deviceId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(oneTimePrekeys)
    .where(and(eq(oneTimePrekeys.deviceId, deviceId), isNull(oneTimePrekeys.claimedAt)));
  return row?.n ?? 0;
}

// POST /prekeys/upload
// Body: {
//   identityKey?: string,
//   signingPublicKey?: string,
//   signedPreKey?: { publicKey: string, signature: string },
//   oneTimePreKeys?: string[]
// }
router.post("/upload", async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth!;
    const device = await resolveOwnDevice(auth.sub, auth.deviceId);
    if (!device) {
      res.status(404).json({ error: "DEVICE_NOT_FOUND" });
      return;
    }

    const {
      identityKey,
      signingPublicKey,
      signedPreKey,
      oneTimePreKeys: otpInput,
    } = req.body as {
      identityKey?: unknown;
      signingPublicKey?: unknown;
      signedPreKey?: { publicKey?: unknown; signature?: unknown };
      oneTimePreKeys?: unknown;
    };

    if (
      signedPreKey === undefined &&
      otpInput === undefined &&
      identityKey === undefined &&
      signingPublicKey === undefined
    ) {
      res.status(400).json({ error: "NOTHING_TO_UPLOAD" });
      return;
    }

    if (identityKey !== undefined) {
      if (!isBase64OfLength(identityKey, 32)) {
        res.status(400).json({ error: "INVALID_IDENTITY_KEY" });
        return;
      }
      if (
        !isPlaceholderIdentityKey(device.identityPublicKey) &&
        device.identityPublicKey !== identityKey
      ) {
        res.status(409).json({ error: "IDENTITY_KEY_MISMATCH" });
        return;
      }
    }

    if (signingPublicKey !== undefined) {
      if (!isBase64OfLength(signingPublicKey, 32)) {
        res.status(400).json({ error: "INVALID_SIGNING_KEY" });
        return;
      }
      if (device.signingPublicKey && device.signingPublicKey !== signingPublicKey) {
        res.status(409).json({ error: "SIGNING_KEY_MISMATCH" });
        return;
      }
    }

    if (signedPreKey !== undefined) {
      if (
        !signedPreKey ||
        !isBase64OfLength(signedPreKey.publicKey, 32) ||
        !isBase64OfLength(signedPreKey.signature, 64)
      ) {
        res.status(400).json({ error: "INVALID_SIGNED_PREKEY" });
        return;
      }
      if (!device.signingPublicKey && signingPublicKey === undefined) {
        res.status(400).json({ error: "SIGNING_KEY_REQUIRED" });
        return;
      }
      if (isPlaceholderIdentityKey(device.identityPublicKey) && identityKey === undefined) {
        res.status(400).json({ error: "IDENTITY_KEY_REQUIRED" });
        return;
      }
    }

    let otps: string[] = [];
    if (otpInput !== undefined) {
      if (
        !Array.isArray(otpInput) ||
        otpInput.length === 0 ||
        otpInput.length > MAX_ONE_TIME_PREKEYS_PER_UPLOAD ||
        !otpInput.every((k) => isBase64OfLength(k, 32))
      ) {
        res.status(400).json({ error: "INVALID_ONE_TIME_PREKEYS" });
        return;
      }
      otps = [...new Set(otpInput as string[])];
    }

    const db = getDb();
    await db.transaction(async (tx) => {
      if (typeof identityKey === "string" && isPlaceholderIdentityKey(device.identityPublicKey)) {
        await tx
          .update(devices)
          .set({ identityPublicKey: identityKey })
          .where(eq(devices.id, device.id));
      }
      if (typeof signingPublicKey === "string" && !device.signingPublicKey) {
        await tx.update(devices).set({ signingPublicKey }).where(eq(devices.id, device.id));
      }
      if (signedPreKey) {
        // Retire the current signed prekey, then insert the new one.
        await tx
          .update(signedPrekeys)
          .set({ replacedAt: new Date() })
          .where(and(eq(signedPrekeys.deviceId, device.id), isNull(signedPrekeys.replacedAt)));
        await tx.insert(signedPrekeys).values({
          deviceId: device.id,
          publicKey: signedPreKey.publicKey as string,
          signature: signedPreKey.signature as string,
        });
      }
      if (otps.length > 0) {
        await tx
          .insert(oneTimePrekeys)
          .values(otps.map((publicKey) => ({ deviceId: device.id, publicKey })))
          .onConflictDoNothing();
      }
    });

    const remaining = await countUnclaimed(device.id);
    res.status(200).json({ ok: true, oneTimePreKeysRemaining: remaining });
  } catch (err) {
    console.error("prekeys upload failed:", err);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// GET /prekeys/count
router.get("/count", async (_req: Request, res: Response) => {
  try {
    const auth = res.locals.auth!;
    const device = await resolveOwnDevice(auth.sub, auth.deviceId);
    if (!device) {
      res.status(404).json({ error: "DEVICE_NOT_FOUND" });
      return;
    }
    const remaining = await countUnclaimed(device.id);
    res.status(200).json({
      oneTimePreKeysRemaining: remaining,
      needsReplenishment: remaining < LOW_PREKEY_THRESHOLD,
    });
  } catch (err) {
    console.error("prekeys count failed:", err);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// GET /prekeys/bundle/:deviceId
router.get("/bundle/:deviceId", async (req: Request, res: Response) => {
  try {
    const targetId = String(req.params.deviceId);
    if (!UUID_RE.test(targetId)) {
      res.status(400).json({ error: "INVALID_DEVICE_ID" });
      return;
    }

    const db = getDb();
    const [device] = await db
      .select({
        id: devices.id,
        identityPublicKey: devices.identityPublicKey,
        signingPublicKey: devices.signingPublicKey,
      })
      .from(devices)
      .where(and(eq(devices.id, targetId), eq(devices.isActive, true), isNull(devices.revokedAt)))
      .limit(1);

    if (
      !device ||
      !device.signingPublicKey ||
      isPlaceholderIdentityKey(device.identityPublicKey)
    ) {
      res.status(404).json({ error: "BUNDLE_NOT_AVAILABLE" });
      return;
    }

    const [spk] = await db
      .select({ publicKey: signedPrekeys.publicKey, signature: signedPrekeys.signature })
      .from(signedPrekeys)
      .where(and(eq(signedPrekeys.deviceId, device.id), isNull(signedPrekeys.replacedAt)))
      .limit(1);

    if (!spk) {
      res.status(404).json({ error: "BUNDLE_NOT_AVAILABLE" });
      return;
    }

    // Atomic claim: SKIP LOCKED means two simultaneous requests can
    // never receive the same one-time prekey.
    const claimed = await db.execute(sql`
      UPDATE one_time_prekeys
      SET claimed_at = now()
      WHERE id = (
        SELECT id FROM one_time_prekeys
        WHERE device_id = ${device.id} AND claimed_at IS NULL
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING public_key
    `);
    const oneTimePreKey = (claimed.rows[0] as { public_key?: string } | undefined)?.public_key;

    res.status(200).json({
      deviceId: device.id,
      identityKey: device.identityPublicKey,
      signingKey: device.signingPublicKey,
      signedPreKey: spk.publicKey,
      signedPreKeySignature: spk.signature,
      // Omitted when the device has run out (documented fallback).
      ...(oneTimePreKey ? { oneTimePreKey } : {}),
    });
  } catch (err) {
    console.error("prekeys bundle failed:", err);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

export default router;