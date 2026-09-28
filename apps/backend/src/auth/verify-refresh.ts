/**
 * Refresh-token verification script.
 *
 * Tests the crypto primitives and the contract:
 *   1. Raw token is NEVER equal to its bcrypt hash
 *   2. Bcrypt hashes are non-deterministic (random salt each time)
 *   3. Different tokens produce different hashes
 *   4. Hash is a valid bcrypt hash ($2b$ prefix, 60 chars)
 *   5. bcrypt.compare matches the correct token
 *   6. bcrypt.compare rejects the wrong token
 *   7. lookup key is deterministic, unique per token, and 32 hex chars
 *   8. token length is sufficient
 *   9. the REAL validateRefreshToken accepts / rejects correctly, including
 *      the expiry branch that a reimplementation had silently skipped
 *
 * Token length, bcrypt cost, the lookup-key derivation, and the bcrypt
 * implementation are all imported from `refresh-token.ts` rather than
 * re-declared here, so this script cannot drift away from what
 * production actually does.
 *
 * Run:  pnpm --filter @wpt/backend exec tsx src/auth/verify-refresh.ts
 */

import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  REFRESH_TOKEN_BYTES,
  BCRYPT_ROUNDS,
  lookupKey,
  validateRefreshToken,
} from "./refresh-token.js";

async function main() {
  const checks: string[] = [];

  // Generate a refresh token the same way issueRefreshToken does
  const rawToken = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
  const tokenLookup = lookupKey(rawToken);
  const tokenHash = await bcrypt.hash(rawToken, BCRYPT_ROUNDS);

  console.log("Raw token (returned to client):", rawToken);
  console.log("Lookup key (DB index):          ", tokenLookup);
  console.log("Bcrypt hash (stored in DB):     ", tokenHash);

  // 1. Raw token is never equal to its hash
  if (rawToken !== tokenHash) {
    checks.push("PASS  raw token != bcrypt hash (raw is never stored in DB)");
  } else {
    checks.push("FAIL  raw token equals hash — security violation");
  }

  // 2. Bcrypt hashes are NON-deterministic (random salt)
  const hash2 = await bcrypt.hash(rawToken, BCRYPT_ROUNDS);
  if (tokenHash !== hash2) {
    checks.push("PASS  bcrypt is non-deterministic (random salt each time)");
  } else {
    checks.push("FAIL  bcrypt produced identical hashes — check salt generation");
  }

  // 3. Different tokens produce different hashes
  const rawToken2 = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
  const hash3 = await bcrypt.hash(rawToken2, BCRYPT_ROUNDS);
  if (tokenHash !== hash3) {
    checks.push("PASS  different tokens → different hashes");
  } else {
    checks.push("FAIL  collision detected");
  }

  // 4. Hash is a valid bcrypt hash (60 chars, $2b$ prefix)
  if (/^\$2[aby]\$\d{2}\$/.test(tokenHash) && tokenHash.length === 60) {
    checks.push(`PASS  hash is valid bcrypt format (${tokenHash.length} chars)`);
  } else {
    checks.push(`FAIL  hash format invalid: ${tokenHash}`);
  }

  // 5. bcrypt.compare matches the correct token
  const validMatch = await bcrypt.compare(rawToken, tokenHash);
  if (validMatch) {
    checks.push("PASS  bcrypt.compare succeeds for correct token");
  } else {
    checks.push("FAIL  bcrypt.compare failed for correct token");
  }

  // 6. bcrypt.compare rejects the wrong token
  const wrongMatch = await bcrypt.compare(rawToken2, tokenHash);
  if (!wrongMatch) {
    checks.push("PASS  bcrypt.compare rejects wrong token");
  } else {
    checks.push("FAIL  bcrypt.compare accepted wrong token");
  }

  // 7. Lookup key is deterministic (same input → same output)
  const lookup2 = lookupKey(rawToken);
  if (tokenLookup === lookup2) {
    checks.push("PASS  lookup key is deterministic (DB index lookups work)");
  } else {
    checks.push("FAIL  lookup key is not deterministic");
  }

  // 8. Different tokens produce different lookup keys
  const lookup3 = lookupKey(rawToken2);
  if (tokenLookup !== lookup3) {
    checks.push("PASS  different tokens → different lookup keys");
  } else {
    checks.push("FAIL  lookup key collision detected");
  }

  // 9. Lookup key is 32 hex chars
  if (/^[0-9a-f]{32}$/.test(tokenLookup)) {
    checks.push(`PASS  lookup key is valid hex (${tokenLookup.length} chars)`);
  } else {
    checks.push(`FAIL  lookup key format invalid: ${tokenLookup}`);
  }

  // 10. Token has sufficient entropy (base64url of 48 bytes = 64 chars)
  if (rawToken.length >= 60) {
    checks.push(`PASS  token length = ${rawToken.length} chars (>=60, sufficient entropy)`);
  } else {
    checks.push(`FAIL  token length = ${rawToken.length} chars (too short)`);
  }

  // 11-15. Exercise the REAL validateRefreshToken.
  //
  // The previous version of this script reimplemented the lookup → bcrypt →
  // revoked_at sequence against an in-memory Map. That asserts the author's
  // idea of the algorithm rather than the shipped one: validateRefreshToken
  // could have been broken in any number of ways and this script would still
  // have passed. It also never covered expiry at all, which is a branch that
  // decides whether a 30-day-old token is honoured.
  //
  // The stub below implements only the query chain validateRefreshToken uses.
  // It is not a database, so the generated SQL is still unverified — that
  // remains the job of integration-test.ts against a real database.
  type SessionRow = {
    id: string;
    userId: string;
    deviceId: string;
    refreshTokenHash: string;
    revokedAt: Date | null;
    expiresAt: Date;
  };

  function stubDb(row: SessionRow | null) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            // Project into the shape the real query selects. `id` is aliased to
            // `sessionId`, so returning the row unprojected would silently omit
            // it and make a correct implementation look broken.
            limit: async () =>
              row
                ? [
                    {
                      sessionId: row.id,
                      userId: row.userId,
                      deviceId: row.deviceId,
                      refreshTokenHash: row.refreshTokenHash,
                      revokedAt: row.revokedAt,
                      expiresAt: row.expiresAt,
                    },
                  ]
                : [],
          }),
        }),
      }),
    } as unknown as Parameters<typeof validateRefreshToken>[1];
  }

  const activeRow: SessionRow = {
    id: "session_1",
    userId: "user_abc123",
    deviceId: "device_xyz789",
    refreshTokenHash: tokenHash,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
  };

  // 11. Valid, unexpired, unrevoked → accepted, with the right identity.
  const accepted = await validateRefreshToken(rawToken, stubDb(activeRow));
  if (
    accepted !== null &&
    accepted.sessionId === "session_1" &&
    accepted.userId === "user_abc123" &&
    accepted.deviceId === "device_xyz789"
  ) {
    checks.push("PASS  validateRefreshToken accepts a valid session and returns its identity");
  } else {
    checks.push(`FAIL  validateRefreshToken rejected a valid token: ${JSON.stringify(accepted)}`);
  }

  // 12. Revoked session → rejected, even though the token and hash still match.
  const revoked = await validateRefreshToken(
    rawToken,
    stubDb({ ...activeRow, revokedAt: new Date() }),
  );
  if (revoked === null) {
    checks.push("PASS  validateRefreshToken rejects a REVOKED session (kill-switch honoured)");
  } else {
    checks.push("FAIL  validateRefreshToken accepted a revoked session");
  }

  // 13. EXPIRED session → rejected. This branch was previously untested.
  const expired = await validateRefreshToken(
    rawToken,
    stubDb({ ...activeRow, expiresAt: new Date(Date.now() - 1000) }),
  );
  if (expired === null) {
    checks.push("PASS  validateRefreshToken rejects an EXPIRED session (30-day window enforced)");
  } else {
    checks.push("FAIL  validateRefreshToken accepted an expired session");
  }

  // 14. Unknown token (no row) → rejected.
  const unknown = await validateRefreshToken(rawToken, stubDb(null));
  if (unknown === null) {
    checks.push("PASS  validateRefreshToken rejects an unknown token (no lookup match)");
  } else {
    checks.push("FAIL  validateRefreshToken accepted an unknown token");
  }

  // 15. Correct lookup key but the presented token is wrong → rejected.
  // Guards the specific mistake of trusting the lookup key on its own.
  const wrongToken = await validateRefreshToken(rawToken2, stubDb(activeRow));
  if (wrongToken === null) {
    checks.push("PASS  validateRefreshToken rejects a wrong token even when a row exists");
  } else {
    checks.push("FAIL  validateRefreshToken accepted the wrong token");
  }

  console.log("\n=== Verification results ===");
  checks.forEach((c) => console.log(c));

  const allPassed = checks.every((c) => c.startsWith("PASS"));
  console.log(`\n${allPassed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);

  process.exit(allPassed ? 0 : 1);
}

main();
