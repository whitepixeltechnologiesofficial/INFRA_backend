/**
 * Legal-acceptance gate integration test against Supabase.
 *
 * Flow:
 *   1. Attempt OTP verify without legal acceptance → REJECTED (403)
 *   2. Record legal acceptance for phone number
 *   3. Attempt OTP verify again → ACCEPTED (gate passes)
 *   4. Different phone number without acceptance → REJECTED
 *   5. Re-acceptance with a new version → stale version is REJECTED
 *   6. Re-accepting the current version → accepted again
 *
 * Run:  $env:DATABASE_URL="..."; pnpm --filter @wpt/backend exec tsx src/auth/legal-gate-test.ts
 */

import {
  recordLegalAcceptance,
  hasAcceptedLegal,
  requireLegalAcceptance,
  LegalAcceptanceRequiredError,
  CURRENT_LEGAL_VERSION,
} from "./index.js";

const checks: string[] = [];

function assert(condition: boolean, label: string) {
  checks.push(condition ? `PASS  ${label}` : `FAIL  ${label}`);
}

async function main() {
  const phoneA = `+1555${Date.now().toString().slice(-7)}`;
  const phoneB = `+1555${Date.now().toString().slice(-7)}9`;
  const legalVersion = "v1.0-2024-01-15";

  console.log(`Phone A: ${phoneA}`);
  console.log(`Phone B: ${phoneB}`);
  console.log(`Legal version: ${legalVersion}\n`);

  // --- Step 1: Attempt gate check WITHOUT acceptance → should throw ---
  console.log("Step 1: Gate check WITHOUT legal acceptance (should REJECT)...");
  try {
    await requireLegalAcceptance(phoneA);
    assert(false, "gate check threw no error — should have rejected");
  } catch (err) {
    assert(
      err instanceof LegalAcceptanceRequiredError,
      "correct error type (LegalAcceptanceRequiredError)",
    );
    assert(
      (err as LegalAcceptanceRequiredError).code === "LEGAL_NOT_ACCEPTED",
      "error code is LEGAL_NOT_ACCEPTED",
    );
    assert(
      (err as LegalAcceptanceRequiredError).statusCode === 403,
      "error statusCode is 403",
    );
  }

  // --- Step 2: hasAcceptedLegal returns false before acceptance ---
  console.log("\nStep 2: hasAcceptedLegal returns false before acceptance...");
  const beforeAccept = await hasAcceptedLegal(phoneA);
  assert(beforeAccept === false, "hasAcceptedLegal returns false");

  // --- Step 3: Record legal acceptance ---
  console.log("\nStep 3: Recording legal acceptance...");
  await recordLegalAcceptance({ phoneNumber: phoneA, legalVersion });

  const afterAccept = await hasAcceptedLegal(phoneA);
  assert(afterAccept === true, "hasAcceptedLegal returns true after acceptance");

  // --- Step 4: Gate check WITH acceptance → should pass ---
  console.log("\nStep 4: Gate check WITH legal acceptance (should ACCEPT)...");
  try {
    await requireLegalAcceptance(phoneA);
    assert(true, "gate check passed without throwing");
  } catch {
    assert(false, "gate check threw — should have accepted");
  }

  // --- Step 5: Different phone number → still rejected ---
  console.log("\nStep 5: Different phone number without acceptance (should REJECT)...");
  try {
    await requireLegalAcceptance(phoneB);
    assert(false, "gate check threw no error — should have rejected");
  } catch (err) {
    assert(
      err instanceof LegalAcceptanceRequiredError,
      "different phone correctly rejected",
    );
  }

  // --- Step 6: Re-acceptance with new version → idempotent update ---
  console.log("\nStep 6: Re-acceptance with new legal version (idempotent)...");
  const newVersion = "v2.0-2025-01-01";
  await recordLegalAcceptance({ phoneNumber: phoneA, legalVersion: newVersion });

  // The row now records newVersion, so a check against newVersion passes...
  const acceptedAtNew = await hasAcceptedLegal(phoneA, newVersion);
  assert(
    acceptedAtNew === true,
    "accepted when checked against the version actually on record",
  );

  // ...but the default gate still requires CURRENT_LEGAL_VERSION, so a
  // user on a stale version is re-prompted. This is the behaviour that
  // was previously missing: the version column was written but never read.
  const staleIsRejected = await hasAcceptedLegal(phoneA);
  assert(
    staleIsRejected === false,
    `stale version rejected (row is "${newVersion}", current is "${CURRENT_LEGAL_VERSION}")`,
  );

  // And the gate itself must block OTP verification for a stale version.
  let gateBlockedStale = false;
  try {
    await requireLegalAcceptance(phoneA);
  } catch (err) {
    gateBlockedStale = err instanceof LegalAcceptanceRequiredError;
  }
  assert(
    gateBlockedStale,
    "requireLegalAcceptance blocks OTP verification on a stale version",
  );

  // Verify the version was updated (query directly)
  const { getDb } = await import("../db/index.js");
  const { legalAcceptances } = await import("../db/legal-acceptances-schema.js");
  const { eq } = await import("drizzle-orm");
  const db = getDb();
  const [row] = await db
    .select({ legalVersion: legalAcceptances.legalVersion })
    .from(legalAcceptances)
    .where(eq(legalAcceptances.phoneNumber, phoneA))
    .limit(1);

  assert(row?.legalVersion === newVersion, `legal version updated to "${newVersion}"`);

  // --- Step 7: Re-accepting the current version restores access ---
  console.log("\nStep 7: Re-accepting the current version restores access...");
  await recordLegalAcceptance({
    phoneNumber: phoneA,
    legalVersion: CURRENT_LEGAL_VERSION,
  });
  const restored = await hasAcceptedLegal(phoneA);
  assert(
    restored === true,
    "accepted again once the current version is on record",
  );
  let gatePassesAgain = true;
  try {
    await requireLegalAcceptance(phoneA);
  } catch {
    gatePassesAgain = false;
  }
  assert(gatePassesAgain, "gate passes again after re-accepting current version");

  // --- Results ---
  console.log("\n=== Results ===");
  checks.forEach((c) => console.log(c));

  const allPassed = checks.every((c) => c.startsWith("PASS"));
  console.log(`\n${allPassed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Legal gate test failed:", err);
  process.exit(1);
});
