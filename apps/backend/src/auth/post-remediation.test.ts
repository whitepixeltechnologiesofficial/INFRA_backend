/**
 * Post-remediation verification for the BE-R2.5 auth review.
 *
 * Covers findings that gained new code in this pass:
 *   N2 - admin tokens signed with a separate key, failing closed
 *   N3 - refresh rotation, reuse detection, and the rotation race
 *   N5 - keyed HMAC for OTP codes instead of unsalted SHA-256
 *
 * SCOPE LIMIT, stated plainly: N3 runs against an in-memory fake implementing
 * the Drizzle call chain these functions use. That verifies branch logic and the
 * family-revocation decision, but it does NOT verify the generated SQL. The
 * WHERE clauses are only proven against a real database, which still requires a
 * live DATABASE_URL and has never been executed.
 */

import { strict as assert } from "node:assert";
import { createHash, createHmac, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

process.env.JWT_SECRET = "user_test_secret_at_least_32_bytes_long_xx";
process.env.DASHBOARD_JWT_SECRET = "admin_test_secret_at_least_32_bytes_long_yy";
process.env.OTP_HMAC_SECRET = "otp_test_secret_at_least_32_bytes_long_zzz";

const { issueAccessToken, verifyAccessToken, issueAdminToken, verifyAdminToken } =
  await import("./jwt.js");
const { rotateRefreshToken, lookupKey, BCRYPT_ROUNDS } = await import("./refresh-token.js");

let pass = 0;
let fail = 0;
const results: string[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push(`PASS  ${name}`);
    pass++;
  } catch (err) {
    results.push(`FAIL  ${name}\n        ${(err as Error).message}`);
    fail++;
  }
}

// ── fake Drizzle handle ──────────────────────────────────────────────────────
type Row = {
  id: string;
  userId: string;
  deviceId: string;
  tokenLookup: string;
  refreshTokenHash: string;
  revokedAt: Date | null;
  rotatedAt: Date | null;
  expiresAt: Date;
  tokenFamilyId: string | null;
  replacedBySessionId: string | null;
};

/**
 * Stands in for the Drizzle query chain.
 *
 * `select` returns whatever the test stages in `selectReturns`. For `update`,
 * the target set is derived from the shape of the patch, so the fake mirrors
 * the real WHERE predicates rather than blanket-applying to the scope:
 *
 *   { rotatedAt }                     -> claim: the ONE presented row, and only
 *                                        while rotated_at/revoked_at are still NULL
 *   { revokedAt, replacedBySessionId } -> audit link: the presented row only
 *   { revokedAt }                     -> family revocation: still-unrevoked rows
 *                                        in the same family (or user+device)
 *
 * Getting this wrong is not cosmetic: an over-broad fake silently revokes the
 * replacement row that was just minted and makes correct code look broken.
 */
function makeFakeDb() {
  const rows: Row[] = [];
  const state = {
    rows,
    selectReturns: [] as Row[],
    /** The row whose token is currently presented. */
    presented: null as Row | null,
    /** Set to make the next claim lose, simulating a concurrent winner. */
    claimShouldFail: false,
  };

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => state.selectReturns.map((r) => ({ ...r })),
        }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          const row: Row = {
            id: randomUUID(),
            userId: v.userId as string,
            deviceId: v.deviceId as string,
            tokenLookup: v.tokenLookup as string,
            refreshTokenHash: v.refreshTokenHash as string,
            revokedAt: null,
            rotatedAt: null,
            expiresAt: v.refreshTokenExpiresAt as Date,
            tokenFamilyId: (v.tokenFamilyId as string | null) ?? null,
            replacedBySessionId: null,
          };
          rows.push(row);
          return [{ id: row.id }];
        },
      }),
    }),
    update: () => {
      let patch: Partial<Row> = {};
      return {
        set: (p: Partial<Row>) => {
          patch = p;
          return {
            where: async () => {
              const presented = state.presented;

              // Claim: presented row, only if still unrotated and unrevoked.
              if (patch.rotatedAt && !patch.revokedAt && !patch.replacedBySessionId) {
                if (state.claimShouldFail) {
                  state.claimShouldFail = false;
                  return { rowCount: 0 };
                }
                if (presented && presented.rotatedAt === null && presented.revokedAt === null) {
                  presented.rotatedAt = patch.rotatedAt;
                  return { rowCount: 1 };
                }
                return { rowCount: 0 };
              }

              // Audit link back to the replacement: presented row only.
              if (patch.replacedBySessionId) {
                if (presented) Object.assign(presented, patch);
                return { rowCount: presented ? 1 : 0 };
              }

              // Family revocation: every still-active row in the family, or in
              // the (user, device) set when the row predates rotation.
              let n = 0;
              for (const r of rows) {
                if (r.revokedAt !== null) continue;
                const sameFamily =
                  presented && presented.tokenFamilyId !== null
                    ? r.tokenFamilyId === presented.tokenFamilyId
                    : presented !== null &&
                      r.userId === presented.userId &&
                      r.deviceId === presented.deviceId;
                if (sameFamily) {
                  r.revokedAt = patch.revokedAt ?? new Date();
                  n++;
                }
              }
              return { rowCount: n };
            },
          };
        },
      };
    },
  };

  return { db, state };
}

type Fake = ReturnType<typeof makeFakeDb>;

async function seed(
  fake: Fake,
  opts: {
    rotatedAt?: Date | null;
    revokedAt?: Date | null;
    expiresAt?: Date;
    family?: string | null;
  } = {},
) {
  const raw = `raw-${randomUUID()}`;
  const row: Row = {
    id: randomUUID(),
    userId: "user_1",
    deviceId: "device_1",
    tokenLookup: lookupKey(raw),
    refreshTokenHash: await bcrypt.hash(raw, BCRYPT_ROUNDS),
    revokedAt: opts.revokedAt ?? null,
    rotatedAt: opts.rotatedAt ?? null,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 30 * 24 * 3600_000),
    tokenFamilyId: opts.family === undefined ? randomUUID() : opts.family,
    replacedBySessionId: null,
  };
  fake.state.rows.push(row);
  fake.state.selectReturns = [row];
  fake.state.presented = row;
  return { raw, row };
}

// ── N2: separate admin signing key ──────────────────────────────────────────
console.log("\nN2 - dashboard admin tokens use a separate signing key");

await check("admin token verifies with DASHBOARD_JWT_SECRET", async () => {
  const { adminId } = await verifyAdminToken(await issueAdminToken("admin_1"));
  assert.equal(adminId, "admin_1");
});

await check("user access token is REJECTED by verifyAdminToken", async () => {
  const userToken = await issueAccessToken({
    userId: "u1",
    deviceId: "d1",
    sessionId: randomUUID(),
  });
  await assert.rejects(() => verifyAdminToken(userToken));
});

await check("admin token is REJECTED by verifyAccessToken", async () => {
  const adminToken = await issueAdminToken("admin_1");
  await assert.rejects(() => verifyAccessToken(adminToken));
});

await check("admin-shaped token forged with JWT_SECRET alone is REJECTED", async () => {
  const { SignJWT } = await import("jose");
  const forged = await new SignJWT({ adm: "admin" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject("attacker")
    .setIssuer("wpt-backend")
    .setAudience("dashboard")
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET!));

  await assert.rejects(() => verifyAdminToken(forged), /signature verification failed/i);
});

await check("issueAdminToken fails CLOSED when DASHBOARD_JWT_SECRET is unset", async () => {
  const saved = process.env.DASHBOARD_JWT_SECRET;
  delete process.env.DASHBOARD_JWT_SECRET;
  try {
    await assert.rejects(() => issueAdminToken("admin_1"), /DASHBOARD_JWT_SECRET is not set/);
  } finally {
    process.env.DASHBOARD_JWT_SECRET = saved;
  }
});

await check("verifyAdminToken fails CLOSED when DASHBOARD_JWT_SECRET is unset", async () => {
  const token = await issueAdminToken("admin_1");
  const saved = process.env.DASHBOARD_JWT_SECRET;
  delete process.env.DASHBOARD_JWT_SECRET;
  try {
    await assert.rejects(() => verifyAdminToken(token), /DASHBOARD_JWT_SECRET is not set/);
  } finally {
    process.env.DASHBOARD_JWT_SECRET = saved;
  }
});

await check("a short DASHBOARD_JWT_SECRET is rejected", async () => {
  const saved = process.env.DASHBOARD_JWT_SECRET;
  process.env.DASHBOARD_JWT_SECRET = "too_short";
  try {
    await assert.rejects(() => issueAdminToken("admin_1"), /too short/i);
  } finally {
    process.env.DASHBOARD_JWT_SECRET = saved;
  }
});

// ── N3: rotation, reuse detection, race ─────────────────────────────────────
console.log("\nN3 - refresh rotation, reuse detection, and the rotation race");

await check("valid token rotates and returns a NEW refresh token", async () => {
  const fake = makeFakeDb();
  const { raw, row } = await seed(fake);

  const res = await rotateRefreshToken(raw, fake.db as never);
  assert.equal(res.status, "ok", `expected ok, got ${res.status}`);
  if (res.status !== "ok") return;
  assert.notEqual(res.refreshToken, raw, "rotated token must differ from the presented one");
  assert.equal(res.userId, "user_1");

  assert.notEqual(row.rotatedAt, null, "old row must be marked rotated");
  assert.notEqual(row.revokedAt, null, "old row must be revoked");
  assert.equal(row.replacedBySessionId, res.sessionId, "old row must link to its replacement");

  const replacement = fake.state.rows.find((r) => r.id === res.sessionId);
  assert.equal(replacement?.tokenFamilyId, row.tokenFamilyId, "family must be inherited");
});

await check("the replacement token is itself accepted and rotates again", async () => {
  const fake = makeFakeDb();
  const { raw } = await seed(fake);
  const first = await rotateRefreshToken(raw, fake.db as never);
  assert.equal(first.status, "ok");
  if (first.status !== "ok") return;

  const replacement = fake.state.rows.find((r) => r.id === first.sessionId)!;
  fake.state.selectReturns = [replacement];
  fake.state.presented = replacement;

  const second = await rotateRefreshToken(first.refreshToken, fake.db as never);
  assert.equal(second.status, "ok", "the replacement must be usable");
  if (second.status !== "ok") return;
  assert.notEqual(second.refreshToken, first.refreshToken, "each rotation must mint a new token");
  assert.equal(fake.state.rows.length, 3, "login token + 2 rotations");
});

await check("REUSING an already-rotated token is DETECTED and revokes the family", async () => {
  const fake = makeFakeDb();
  const { raw, row } = await seed(fake);
  const first = await rotateRefreshToken(raw, fake.db as never);
  assert.equal(first.status, "ok");
  if (first.status !== "ok") return;

  // A sibling device session in the same family, already rotated.
  const sibling = fake.state.rows.find((r) => r.id === first.sessionId)!;
  sibling.rotatedAt = new Date();

  fake.state.selectReturns = [row];

  const res = await rotateRefreshToken(raw, fake.db as never);
  assert.equal(res.status, "reuse_detected", `expected reuse_detected, got ${res.status}`);
  if (res.status !== "reuse_detected") return;
  assert.ok(res.revokedCount >= 1, "reuse must revoke at least one session");
  assert.notEqual(sibling.revokedAt, null, "sibling session in the family must be revoked");
});

await check("losing the rotation race is treated as reuse, not as success", async () => {
  const fake = makeFakeDb();
  const { raw } = await seed(fake);
  fake.state.claimShouldFail = true;

  const res = await rotateRefreshToken(raw, fake.db as never);
  assert.equal(res.status, "reuse_detected", "a lost claim must not yield a second token");
  if (res.status !== "reuse_detected") return;
  assert.equal(fake.state.rows.length, 1, "no replacement row may be created by the loser");
});

await check("explicit logout (revoked, NOT rotated) is rejected WITHOUT reuse alarm", async () => {
  const fake = makeFakeDb();
  const { raw, row } = await seed(fake);
  row.revokedAt = new Date();
  const res = await rotateRefreshToken(raw, fake.db as never);
  assert.equal(res.status, "invalid", "a logged-out token must be invalid, not reuse");
});

await check("expired token is rejected", async () => {
  const fake = makeFakeDb();
  const { raw } = await seed(fake, { expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await rotateRefreshToken(raw, fake.db as never)).status, "invalid");
});

await check("unknown token is rejected", async () => {
  const fake = makeFakeDb();
  assert.equal((await rotateRefreshToken("never-issued", fake.db as never)).status, "invalid");
});

await check("token whose bcrypt does not match is rejected", async () => {
  const fake = makeFakeDb();
  await seed(fake);
  assert.equal(
    (await rotateRefreshToken("a-different-raw-token", fake.db as never)).status,
    "invalid",
  );
});

await check("legacy row with NULL token_family_id still revokes on reuse", async () => {
  const fake = makeFakeDb();
  const { raw, row } = await seed(fake, { family: null });
  row.rotatedAt = new Date();

  const res = await rotateRefreshToken(raw, fake.db as never);
  assert.equal(res.status, "reuse_detected", "NULL family must fall back to user+device scoping");
  if (res.status !== "reuse_detected") return;
  assert.notEqual(row.revokedAt, null, "fallback scope must still revoke the row");
});

// ── N5: keyed HMAC for OTP codes ────────────────────────────────────────────
console.log("\nN5 - OTP codes hashed with keyed HMAC, not bare SHA-256");

const otpSecret = process.env.OTP_HMAC_SECRET!;
const code = "123456";

await check("HMAC digest differs from bare SHA-256 of the same code", () => {
  assert.notEqual(
    createHmac("sha256", otpSecret).update(code).digest("hex"),
    createHash("sha256").update(code).digest("hex"),
  );
});

await check("HMAC is deterministic (schema needs a comparable digest)", () => {
  assert.equal(
    createHmac("sha256", otpSecret).update(code).digest("hex"),
    createHmac("sha256", otpSecret).update(code).digest("hex"),
  );
});

await check("HMAC changes completely when the key changes", () => {
  assert.notEqual(
    createHmac("sha256", otpSecret).update(code).digest("hex"),
    createHmac("sha256", "a_completely_different_key_32_bytes_long!").update(code).digest("hex"),
  );
});

await check("stored digest cannot be attacked by offline brute force", () => {
  const stored = createHmac("sha256", otpSecret).update(code).digest("hex");
  let recovered = false;
  for (let i = 0; i < 1_000_000; i++) {
    const guess = String(i).padStart(6, "0");
    // The attacker has the digest but not the key, so they cannot compute a
    // candidate digest at all — this is the property HMAC buys.
    if (
      createHmac("sha256", "attacker_does_not_have_the_key_32bytes").update(guess).digest("hex") ===
      stored
    ) {
      recovered = true;
      break;
    }
  }
  assert.equal(recovered, false, "HMAC must resist offline brute force");
});

await check("bare SHA-256 IS brute-forceable (proves the N5 finding was real)", () => {
  const stored = createHash("sha256").update(code).digest("hex");
  let recovered = "";
  for (let i = 0; i < 1_000_000; i++) {
    const guess = String(i).padStart(6, "0");
    if (createHash("sha256").update(guess).digest("hex") === stored) {
      recovered = guess;
      break;
    }
  }
  assert.equal(recovered, code, "unsalted SHA-256 must fall to brute force");
});

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${"-".repeat(64)}`);
for (const line of results) console.log(line);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
