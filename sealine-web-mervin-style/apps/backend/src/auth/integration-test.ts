/**
 * Full integration test against a real database.
 *
 * Flow:
 *   1. Issue a refresh token  → insert into sessions table
 *   2. Validate it            → hash lookup, revoked_at=null → ACCEPT
 *   3. Revoke the session     → set revoked_at to now
 *   4. Validate again         → hash lookup, revoked_at!=null → REJECT
 *   5. Unknown token          → no row found → REJECT
 *
 * Every session row created here is deleted again in a `finally` block, so the
 * script can be pointed at a shared database without leaving residue.
 *
 * Run:  $env:DATABASE_URL="..."; pnpm --filter @wpt/backend exec tsx src/auth/integration-test.ts
 *
 * REQUIRES: a throwaway database with migrations/013 applied. This script
 * INSERTS and DELETEs rows; do not point it at production or shared data.
 */

import { issueRefreshToken, validateRefreshToken, revokeSession } from "./index.js";
import { getDb } from "../db/index.js";
import { sessions } from "../db/sessions-schema.js";
import { inArray } from "drizzle-orm";

const checks: string[] = [];

function assert(condition: boolean, label: string) {
  checks.push(condition ? `PASS  ${label}` : `FAIL  ${label}`);
}

async function main() {
  const testUserId = `test_user_${Date.now()}`;
  const testDeviceId = `test_device_${Date.now()}`;

  // Every session this run creates, so they can be REMOVED rather than left
  // behind. The previous version called revokeSession() and called that
  // "cleanup", but revocation only sets revoked_at — the rows stayed in the
  // table forever, so each run of this script permanently added dead sessions
  // to a database that is meant to hold live auth state.
  const createdSessionIds: string[] = [];

  console.log(`Test user: ${testUserId}`);
  console.log(`Test device: ${testDeviceId}\n`);

  try {
    // --- Step 1: Issue a refresh token ---
    console.log("Step 1: Issuing refresh token...");
    const { refreshToken, sessionId } = await issueRefreshToken({
      userId: testUserId,
      deviceId: testDeviceId,
    });
    createdSessionIds.push(sessionId);

    // The raw token is deliberately NOT printed. A refresh token in a log is a
    // bearer credential: anyone with log access can use it for the full 30-day
    // window. Only the non-secret session id is safe to show.
    console.log(`  Session ID: ${sessionId}`);
    console.log("  Refresh token: issued (value withheld — it is a bearer credential)");

    assert(refreshToken.length > 0, "refresh token is non-empty");
    assert(sessionId.length > 0, "session ID is non-empty");
    assert(refreshToken !== sessionId, "token and session ID are different");

    // --- Step 2: Validate the token (should succeed) ---
    console.log("\nStep 2: Validating token (should ACCEPT)...");
    const validSession = await validateRefreshToken(refreshToken);

    assert(validSession !== null, "token validation succeeds");
    assert(validSession?.sessionId === sessionId, "session ID matches");
    assert(validSession?.userId === testUserId, "user ID matches");
    assert(validSession?.deviceId === testDeviceId, "device ID matches");

    // --- Step 3: Revoke the session ---
    console.log("\nStep 3: Revoking session...");
    await revokeSession(sessionId);
    console.log("  Session revoked.");

    // --- Step 4: Validate again (should fail — revoked) ---
    console.log("\nStep 4: Validating revoked token (should REJECT)...");
    const revokedSession = await validateRefreshToken(refreshToken);

    assert(revokedSession === null, "revoked token is rejected");

    // --- Step 5: Unknown token (should fail — no row) ---
    console.log("\nStep 5: Validating unknown token (should REJECT)...");
    const fakeToken = "a".repeat(64) + "b".repeat(64); // won't match any hash
    const unknownSession = await validateRefreshToken(fakeToken);

    assert(unknownSession === null, "unknown token is rejected");

    // --- Step 6: Issue a second token and verify it works independently ---
    console.log("\nStep 6: Issuing second token (fresh session)...");
    const { refreshToken: token2, sessionId: session2 } = await issueRefreshToken({
      userId: testUserId,
      deviceId: "device_b",
    });
    createdSessionIds.push(session2);

    const valid2 = await validateRefreshToken(token2);
    assert(valid2 !== null, "second token validates");
    assert(valid2?.sessionId === session2, "second session ID matches");
    assert(valid2?.deviceId === "device_b", "second token has correct device ID");

    // --- Results ---
    console.log("\n=== Results ===");
    checks.forEach((c) => console.log(c));

    const allPassed = checks.every((c) => c.startsWith("PASS"));
    console.log(`\n${allPassed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);

    process.exitCode = allPassed ? 0 : 1;
  } finally {
    // Hard-delete the rows this run created. Runs against a throwaway database
    // are fine, but a script that leaves residue is unsafe to point at anything
    // shared, and residue is exactly what made the earlier cleanup insufficient.
    if (createdSessionIds.length > 0) {
      try {
        const db = getDb();
        const deleted = await db
          .delete(sessions)
          .where(inArray(sessions.id, createdSessionIds));
        console.log(
          `\nCleanup: deleted ${deleted.rowCount ?? 0} test session row(s) ` +
            `[${createdSessionIds.join(", ")}]`,
        );
      } catch (cleanupErr) {
        // Never let cleanup mask the test result, but say so loudly — leftover
        // rows are something the operator needs to know about.
        console.error(
          `Cleanup FAILED for sessions ${createdSessionIds.join(", ")}: ` +
            `${(cleanupErr as Error).message}`,
        );
      }
    }
  }
}

main().catch((err) => {
  console.error("Integration test failed:", err);
  process.exit(1);
});
