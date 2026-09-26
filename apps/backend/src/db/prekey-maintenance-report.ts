/**
 * BE-5.2: Prekey maintenance report.
 *
 * Run manually: pnpm --filter @wpt/backend exec tsx src/db/prekey-maintenance-report.ts
 *
 * DESIGN NOTE (departs from ENC-4.1's prekey-maintenance.ts): that job
 * generated one-time prekey KEYPAIRS on the server and stored the public
 * half, discarding the private half. That defeats X3DH — the server has
 * no way to hand a real device a private key it never had, so any bundle
 * containing a server-fabricated one-time prekey cannot be used to
 * complete a real session. Flag this for review before merging.
 *
 * This job does not generate keys. It only REPORTS which active devices
 * need the client to act:
 *   - one-time prekeys below LOW_PREKEY_THRESHOLD (server/routes/prekeys.ts)
 *   - no current signed prekey, or the current one older than
 *     SIGNED_PREKEY_ROTATION_MS (placeholder: 7 days, per ENC-4.1's
 *     Tech Arch §8.3 reference — confirm against the TAD)
 *
 * The device's own client is responsible for generating and uploading
 * new prekeys via POST /prekeys/upload when it next connects. This job
 * writes nothing — it is safe to run as often as needed.
 */

import "dotenv/config";
import { getDb } from "./index.js";
import { devices } from "./devices-schema.js";
import { signedPrekeys, oneTimePrekeys } from "./prekeys-schema.js";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { LOW_PREKEY_THRESHOLD } from "../routes/prekeys.js";

// PLACEHOLDER: confirm against the TAD.
export const SIGNED_PREKEY_ROTATION_MS = 7 * 24 * 60 * 60 * 1000;

export interface MaintenanceFinding {
  deviceId: string;
  userId: string;
  oneTimePreKeysRemaining: number;
  needsOneTimeReplenishment: boolean;
  signedPreKeyAgeDays: number | null; // null = no signed prekey at all
  needsSignedPreKeyRotation: boolean;
}

export async function runMaintenanceReport(): Promise<MaintenanceFinding[]> {
  const db = getDb();

  const activeDevices = await db
    .select({ id: devices.id, userId: devices.userId })
    .from(devices)
    .where(and(eq(devices.isActive, true), isNull(devices.revokedAt)));

  const findings: MaintenanceFinding[] = [];

  for (const device of activeDevices) {
    const [otpCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(oneTimePrekeys)
      .where(and(eq(oneTimePrekeys.deviceId, device.id), isNull(oneTimePrekeys.consumedAt)));
    const remaining = otpCount?.n ?? 0;

    const [currentSpk] = await db
      .select({ createdAt: signedPrekeys.createdAt })
      .from(signedPrekeys)
      .where(eq(signedPrekeys.deviceId, device.id))
      .orderBy(desc(signedPrekeys.keyId))
      .limit(1);

    const ageMs = currentSpk ? Date.now() - new Date(currentSpk.createdAt).getTime() : null;
    const ageDays = ageMs === null ? null : Math.floor(ageMs / (24 * 60 * 60 * 1000));

    const needsOtp = remaining < LOW_PREKEY_THRESHOLD;
    const needsRotation = ageMs === null || ageMs >= SIGNED_PREKEY_ROTATION_MS;

    if (needsOtp || needsRotation) {
      findings.push({
        deviceId: device.id,
        userId: device.userId,
        oneTimePreKeysRemaining: remaining,
        needsOneTimeReplenishment: needsOtp,
        signedPreKeyAgeDays: ageDays,
        needsSignedPreKeyRotation: needsRotation,
      });
    }
  }

  return findings;
}

async function main() {
  const findings = await runMaintenanceReport();
  if (findings.length === 0) {
    console.log("All active devices have healthy prekey stock. Nothing to report.");
    return;
  }
  console.log(`${findings.length} device(s) need client-side prekey action:\n`);
  for (const f of findings) {
    const parts: string[] = [];
    if (f.needsOneTimeReplenishment) {
      parts.push(`one-time prekeys low (${f.oneTimePreKeysRemaining} left)`);
    }
    if (f.needsSignedPreKeyRotation) {
      parts.push(
        f.signedPreKeyAgeDays === null
          ? "no signed prekey uploaded"
          : `signed prekey is ${f.signedPreKeyAgeDays} day(s) old`,
      );
    }
    console.log(`  device ${f.deviceId} (user ${f.userId}): ${parts.join(", ")}`);
  }
}

// Only run when invoked directly (tsx src/db/prekey-maintenance-report.ts),
// not when imported by a test.
if (process.argv[1] && process.argv[1].endsWith("prekey-maintenance-report.ts")) {
  main().catch((err) => {
    console.error("Maintenance report failed:", err);
    process.exit(1);
  });
}