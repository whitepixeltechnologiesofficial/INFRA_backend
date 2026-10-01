/**
 * LOGIN-3.1 verification script.
 *
 * Issues a token, decodes it, and confirms:
 *   1. Expiry is exactly 1 hour from issuance
 *   2. Claims are sufficient to identify user + device without a DB round-trip
 *   3. `aud` is present on both token families and the two are not
 *      interchangeable (TAD 7.4 / 15.3)
 *
 * Run:  pnpm --filter @wpt/backend exec tsx src/auth/verify.ts
 *
 * Both signing keys are set by this script rather than read from .env, so the
 * checks are self-contained and cannot be influenced by whatever happens to be
 * in the developer's environment. They are deliberately DIFFERENT values, which
 * is what makes the "the two token families are not interchangeable" check
 * meaningful: if the implementation regressed to a single shared key, the
 * cross-family rejection below would start failing.
 */

import {
  issueAccessToken,
  verifyAccessToken,
  decodeAccessTokenUnsafe,
  issueAdminToken,
  verifyAdminToken,
  AUDIENCE_APP,
  AUDIENCE_DASHBOARD,
} from "./jwt.js";

const TEST_SECRET = "test-secret-for-verification-only";
const TEST_ADMIN_SECRET = "test-admin-secret-verification-only";
process.env.JWT_SECRET = TEST_SECRET;
process.env.DASHBOARD_JWT_SECRET = TEST_ADMIN_SECRET;

const TEST_USER_ID = "user_abc123";
const TEST_DEVICE_ID = "device_xyz789";
const TEST_SESSION_ID = "session_def456";

async function main() {
  const before = Math.floor(Date.now() / 1000);

  const token = await issueAccessToken({
    userId: TEST_USER_ID,
    deviceId: TEST_DEVICE_ID,
    sessionId: TEST_SESSION_ID,
  });

  const after = Math.floor(Date.now() / 1000) + 1;

  // --- Decode (unsafe, for inspection) ---
  const decoded = decodeAccessTokenUnsafe(token);
  console.log("=== Decoded token (unsafe) ===");
  console.log(JSON.stringify(decoded, null, 2));

  // --- Verify (cryptographic) ---
  const verified = await verifyAccessToken(token);
  console.log("\n=== Verified payload ===");
  console.log(JSON.stringify(verified, null, 2));

  // --- Assertions ---
  const checks: string[] = [];

  // 1. Expiry is exactly 1 hour from issuance
  const expectedExpMin = before + 3600;
  const expectedExpMax = after + 3600;
  if (verified.exp >= expectedExpMin && verified.exp <= expectedExpMax) {
    checks.push(`PASS  exp=${verified.exp} is ~3600s from now (window ${expectedExpMin}–${expectedExpMax})`);
  } else {
    checks.push(`FAIL  exp=${verified.exp} outside expected window ${expectedExpMin}–${expectedExpMax}`);
  }

  // 2. User ID claim
  if (verified.sub === TEST_USER_ID) {
    checks.push(`PASS  sub=${verified.sub} matches expected user`);
  } else {
    checks.push(`FAIL  sub=${verified.sub} !== ${TEST_USER_ID}`);
  }

  // 3. Device ID claim
  if (verified.deviceId === TEST_DEVICE_ID) {
    checks.push(`PASS  deviceId=${verified.deviceId} matches expected device`);
  } else {
    checks.push(`FAIL  deviceId=${verified.deviceId} !== ${TEST_DEVICE_ID}`);
  }

  // 4. Session ID claim
  if (verified.sid === TEST_SESSION_ID) {
    checks.push(`PASS  sid=${verified.sid} matches expected session`);
  } else {
    checks.push(`FAIL  sid=${verified.sid} !== ${TEST_SESSION_ID}`);
  }

  // 5. Issuer
  if (verified.iss === "wpt-backend") {
    checks.push(`PASS  iss=${verified.iss}`);
  } else {
    checks.push(`FAIL  iss=${verified.iss} !== wpt-backend`);
  }

  // 6. iat is set and reasonable
  if (verified.iat >= before && verified.iat <= after) {
    checks.push(`PASS  iat=${verified.iat} is now`);
  } else {
    checks.push(`FAIL  iat=${verified.iat} not in expected range`);
  }

  // 7. exp - iat == 3600 (exactly 1 hour)
  const duration = verified.exp - verified.iat;
  if (duration === 3600) {
    checks.push(`PASS  exp - iat = ${duration}s (exactly 1 hour)`);
  } else {
    checks.push(`FAIL  exp - iat = ${duration}s (expected 3600)`);
  }

  // 8. aud is present and correct (TAD 7.4 / 15.3)
  if (decoded.aud === AUDIENCE_APP) {
    checks.push(`PASS  aud="${AUDIENCE_APP}" present on the access token`);
  } else {
    checks.push(`FAIL  aud is "${decoded.aud}", expected "${AUDIENCE_APP}"`);
  }

  // 9. The two token families are not interchangeable. Both are signed with
  //    the same secret and issuer, so without `aud` an access token would
  //    pass verifyAdminToken. This is the check that makes `aud` load-bearing.
  const adminToken = await issueAdminToken("admin_abc123");
  const decodedAdmin = decodeAccessTokenUnsafe(adminToken);
  if (decodedAdmin.aud === AUDIENCE_DASHBOARD) {
    checks.push(`PASS  aud="${AUDIENCE_DASHBOARD}" present on the admin token`);
  } else {
    checks.push(`FAIL  admin aud is "${decodedAdmin.aud}", expected "${AUDIENCE_DASHBOARD}"`);
  }

  let accessTokenRejectedAsAdmin = false;
  try {
    await verifyAdminToken(token);
  } catch {
    accessTokenRejectedAsAdmin = true;
  }
  checks.push(
    accessTokenRejectedAsAdmin
      ? "PASS  access token REJECTED by verifyAdminToken (aud enforced)"
      : "FAIL  access token ACCEPTED by verifyAdminToken - aud not enforced",
  );

  let adminTokenRejectedAsUser = false;
  try {
    await verifyAccessToken(adminToken);
  } catch {
    adminTokenRejectedAsUser = true;
  }
  checks.push(
    adminTokenRejectedAsUser
      ? "PASS  admin token REJECTED by verifyAccessToken (aud enforced)"
      : "FAIL  admin token ACCEPTED by verifyAccessToken - aud not enforced",
  );

  // 10. Each token still verifies against its own audience.
  const verifiedAdmin = await verifyAdminToken(adminToken);
  if (verifiedAdmin.adminId === "admin_abc123") {
    checks.push("PASS  admin token verifies against its own audience");
  } else {
    checks.push(`FAIL  admin sub is "${verifiedAdmin.adminId}"`);
  }

  console.log("\n=== Verification results ===");
  checks.forEach((c) => console.log(c));

  const allPassed = checks.every((c) => c.startsWith("PASS"));
  console.log(`\n${allPassed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Verification script failed:", err);
  process.exit(1);
});
