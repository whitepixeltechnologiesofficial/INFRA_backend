/**
 * BE-5.2: Prekey distribution routes (X3DH).
 *
 *   POST /prekeys/upload            publish identity key, signing key, signed prekey and/or one-time prekeys
 *   GET  /prekeys/count             how many unused one-time prekeys I have left
 *   GET  /prekeys/bundle/:deviceId  fetch a device's prekey bundle
 *
 * Works with the existing signed_prekeys / one_time_prekeys tables
 * (ENC-4.1): every key has an integer key_id, so the receiving device
 * knows which private key a session used.
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
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { devices } from "../db/devices-schema.js";
import { signedPrekeys, oneTimePrekeys } from "../db/prekeys-schema.js";
import { requireAuth } from "../middleware/auth.js";

const router: Router = Router();
router.use(requireAuth);

// PLACEHOLDERS from the ENC-4.1 notes (Tech Arch 8.3): batches of 100,
// replenish below 20. Confirm against the TAD.
export const MAX_ONE_TIME_PREKEYS_PER_UPLOAD = 100;
export const LOW_PREKEY_THRESHOLD = 20;

const MAX_KEY_ID = 2147483647; // Postgres integer max

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

function isValidKeyId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_KEY_ID;
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

async function countUnconsumed(deviceId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(oneTimePrekeys)
    .where(and(eq(oneTimePrekeys.deviceId, deviceId), isNull(oneTimePrekeys.consumedAt)));
  return row?.n ?? 0;
}

// POST /prekeys/upload
// Body: {
//   identityKey?: string,
//   signingPublicKey?: string,
//   signedPreKey?: { keyId: number, publicKey: string, signature: string },
//   oneTimePreKeys?: { keyId: number, publicKey: string }[]
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
      signedPreKey?: { keyId?: unknown; publicKey?: unknown; signature?: unknown };
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
        !isValidKeyId(signedPreKey.keyId) ||
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

    let otps: { keyId: number; publicKey: string }[] = [];
    if (otpInput !== undefined) {
      if (
        !Array.isArray(otpInput) ||
        otpInput.length === 0 ||
        otpInput.length > MAX_ONE_TIME_PREKEYS_PER_UPLOAD ||
        !otpInput.every(
          (k) => k && isValidKeyId(k.keyId) && isBase64OfLength(k.publicKey, 32),
        )
      ) {
        res.status(400).json({ error: "INVALID_ONE_TIME_PREKEYS" });
        return;
      }
      // Drop duplicate key ids within the request (first one wins).
      const seen = new Set<number>();
      for (const k of otpInput as { keyId: number; publicKey: string }[]) {
        if (!seen.has(k.keyId)) {
          seen.add(k.keyId);
          otps.push({ keyId: k.keyId, publicKey: k.publicKey });
        }
      }
    }

    const db = getDb();
    let accepted = 0;
    let signedPreKeyConflict = false;

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
        // The current signed prekey is the highest key_id, so a new one
        // must have a higher key_id than any existing one.
        const [top] = await tx
          .select({ keyId: signedPrekeys.keyId })
          .from(signedPrekeys)
          .where(eq(signedPrekeys.deviceId, device.id))
          .orderBy(desc(signedPrekeys.keyId))
          .limit(1);
        if (top && (signedPreKey.keyId as number) <= top.keyId) {
          signedPreKeyConflict = true;
          tx.rollback();
        }
        await tx.insert(signedPrekeys).values({
          deviceId: device.id,
          keyId: signedPreKey.keyId as number,
          publicKey: signedPreKey.publicKey as string,
          signature: signedPreKey.signature as string,
        });
      }
      if (otps.length > 0) {
        const inserted = await tx
          .insert(oneTimePrekeys)
          .values(otps.map((k) => ({ deviceId: device.id, keyId: k.keyId, publicKey: k.publicKey })))
          .onConflictDoNothing()
          .returning({ id: oneTimePrekeys.id });
        accepted = inserted.length;
      }
    }).catch((err) => {
      if (signedPreKeyConflict) return; // handled below
      throw err;
    });

    if (signedPreKeyConflict) {
      res.status(409).json({ error: "SIGNED_PREKEY_ID_NOT_INCREASING" });
      return;
    }

    const remaining = await countUnconsumed(device.id);
    res.status(200).json({
      ok: true,
      oneTimePreKeysAccepted: accepted,
      oneTimePreKeysRemaining: remaining,
    });
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
    const remaining = await countUnconsumed(device.id);
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

    // Current signed prekey = highest key_id.
    const [spk] = await db
      .select({
        keyId: signedPrekeys.keyId,
        publicKey: signedPrekeys.publicKey,
        signature: signedPrekeys.signature,
      })
      .from(signedPrekeys)
      .where(eq(signedPrekeys.deviceId, device.id))
      .orderBy(desc(signedPrekeys.keyId))
      .limit(1);

    if (!spk) {
      res.status(404).json({ error: "BUNDLE_NOT_AVAILABLE" });
      return;
    }

    // Atomic claim: SKIP LOCKED means two simultaneous requests can
    // never receive the same one-time prekey.
    const claimed = await db.execute(sql`
      UPDATE one_time_prekeys
      SET consumed_at = now()
      WHERE id = (
        SELECT id FROM one_time_prekeys
        WHERE device_id = ${device.id} AND consumed_at IS NULL
        ORDER BY key_id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING key_id, public_key
    `);
    const otp = claimed.rows[0] as { key_id?: number; public_key?: string } | undefined;

    res.status(200).json({
      deviceId: device.id,
      identityKey: device.identityPublicKey,
      signingKey: device.signingPublicKey,
      signedPreKeyId: spk.keyId,
      signedPreKey: spk.publicKey,
      signedPreKeySignature: spk.signature,
      // Omitted when the device has run out (documented fallback).
      ...(otp?.public_key
        ? { oneTimePreKeyId: otp.key_id, oneTimePreKey: otp.public_key }
        : {}),
    });
  } catch (err) {
    console.error("prekeys bundle failed:", err);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

export default router;