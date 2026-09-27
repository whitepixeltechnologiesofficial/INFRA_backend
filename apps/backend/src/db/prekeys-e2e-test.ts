/**
 * BE-5.2 verification: prekey distribution end-to-end test.
 *
 * Starts the real Express app on a random port, creates two throwaway
 * users + devices (Alice, Bob), and exercises the prekey routes.
 * Uses the EXISTING signed_prekeys / one_time_prekeys tables (ENC-4.1),
 * which already hold live rows — this test only adds/removes its own
 * rows and prints a before/after count to prove nothing else was touched.
 *
 * Requires devices.signing_public_key to exist (apply migrations/012 first).
 * Run: pnpm --filter @wpt/backend exec tsx src/db/prekeys-e2e-test.ts
 */

import "dotenv/config";
import {
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPublicKey,
  randomUUID,
  randomInt,
  type KeyObject,
} from "node:crypto";
import type { AddressInfo } from "node:net";
import { createPool } from "./pool.js";
import { createApp } from "../app.js";
import { issueAccessToken } from "../auth/jwt.js";


// ── tiny test harness ──
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`, detail !== undefined ? `\n        -> ${JSON.stringify(detail)}` : "");
  }
}

// ── key helpers ──
const rawPub = (k: KeyObject) => Buffer.from(k.export({ format: "jwk" }).x as string, "base64url");
const b64 = (b: Buffer) => b.toString("base64");
const newX25519 = () => generateKeyPairSync("x25519");

let nextKeyId = 1;
const newOtps = (n: number) =>
  Array.from({ length: n }, () => ({
    keyId: nextKeyId++,
    publicKey: b64(rawPub(newX25519().publicKey)),
  }));

function makeDeviceKeys() {
  const identity = newX25519();
  const signing = generateKeyPairSync("ed25519");
  const spk = newX25519();
  const spkRaw = rawPub(spk.publicKey);
  const signature = edSign(null, spkRaw, signing.privateKey);
  return {
    identityKey: b64(rawPub(identity.publicKey)),
    signingPublicKey: b64(rawPub(signing.publicKey)),
    signingPublicRaw: rawPub(signing.publicKey),
    signing,
    signedPreKey: { keyId: 1, publicKey: b64(spkRaw), signature: b64(signature) },
  };
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const pool = createPool({ connectionString: dbUrl });

  const t = await pool.query(
    `SELECT to_regclass('public.one_time_prekeys') AS a, to_regclass('public.signed_prekeys') AS b`,
  );
  if (!t.rows[0].a || !t.rows[0].b) {
    await pool.end();
    throw new Error("Prekey tables not found.");
  }

  const col = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'devices' AND column_name = 'signing_public_key'`,
  );
  if (col.rowCount === 0) {
    await pool.end();
    throw new Error("devices.signing_public_key is missing. Apply migrations/012 first.");
  }

  const before = await pool.query(
    `SELECT (SELECT count(*)::int FROM signed_prekeys) AS s, (SELECT count(*)::int FROM one_time_prekeys) AS o`,
  );

  const { httpServer, io } = createApp();
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/api`;

  const userIds: string[] = [];
  const deviceIds: string[] = [];

  try {
    const { API_VERSION } = await import("@wpt/shared");
    const api = async (path: string, token: string | null, method = "GET", body?: unknown) => {
      const res = await fetch(`${base}/${API_VERSION}/prekeys${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      let json: any = null;
      try {
        json = await res.json();
      } catch {
        /* empty body */
      }
      return { status: res.status, json };
    };

    async function makeUser() {
      const userId = randomUUID();
      const deviceId = randomUUID();
      const phone = `+1${randomInt(2000000000, 2999999999)}`;
            await pool.query(`INSERT INTO users (id, phone_number, name) VALUES ($1, $2, $3)`, [
        userId,
        phone,
        `Test User ${userId.slice(0, 8)}`,
      ]);
      userIds.push(userId);
      await pool.query(
        `INSERT INTO devices (id, user_id, device_type, platform, identity_public_key)
         VALUES ($1, $2, 'phone', 'android', $3)`,
        [deviceId, userId, `pf_${deviceId}`],
      );
      deviceIds.push(deviceId);
      const token = await issueAccessToken({ userId, deviceId, sessionId: randomUUID() });
      return { userId, deviceId, token };
    }
    const alice = await makeUser();
    const bob = await makeUser();
    const aliceKeys = makeDeviceKeys();

    console.log("\n[1] Auth and not-ready states");
    check("no token -> 401", (await api("/count", null)).status === 401);
    check(
      "bundle before any upload -> 404",
      (await api(`/bundle/${alice.deviceId}`, bob.token)).status === 404,
    );
    check("bundle for malformed id -> 400", (await api(`/bundle/not-a-uuid`, bob.token)).status === 400);

    console.log("\n[2] Upload validation");
    check("empty upload -> 400", (await api("/upload", alice.token, "POST", {})).status === 400);
    check(
      "wrong-size one-time key -> 400",
      (await api("/upload", alice.token, "POST", { oneTimePreKeys: [{ keyId: 1, publicKey: "c2hvcnQ=" }] })).status === 400,
    );
    check(
      "signed prekey without identity key (placeholder still set) -> 400",
      (
        await api("/upload", alice.token, "POST", {
          signingPublicKey: aliceKeys.signingPublicKey,
          signedPreKey: aliceKeys.signedPreKey,
        })
      ).status === 400,
    );

    console.log("\n[3] Successful upload");
    const otps1 = newOtps(5);
    const up = await api("/upload", alice.token, "POST", {
      identityKey: aliceKeys.identityKey,
      signingPublicKey: aliceKeys.signingPublicKey,
      signedPreKey: aliceKeys.signedPreKey,
      oneTimePreKeys: otps1,
    });
    check("upload -> 200, 5 remaining", up.status === 200 && up.json?.oneTimePreKeysRemaining === 5, up);
    check(
      "changing identity key later -> 409",
      (await api("/upload", alice.token, "POST", { identityKey: b64(rawPub(newX25519().publicKey)) })).status === 409,
    );

    console.log("\n[4] Bundle is structurally valid (X3DH)");
    const b1 = await api(`/bundle/${alice.deviceId}`, bob.token);
    const bundle = b1.json;
    check("bundle -> 200", b1.status === 200, b1);
    check("identityKey matches upload", bundle?.identityKey === aliceKeys.identityKey);
    check("signingKey matches upload", bundle?.signingKey === aliceKeys.signingPublicKey);
    check(
      "all keys are 32 bytes, signature is 64 bytes",
      Buffer.from(bundle?.identityKey ?? "", "base64").length === 32 &&
        Buffer.from(bundle?.signingKey ?? "", "base64").length === 32 &&
        Buffer.from(bundle?.signedPreKey ?? "", "base64").length === 32 &&
        Buffer.from(bundle?.oneTimePreKey ?? "", "base64").length === 32 &&
        Buffer.from(bundle?.signedPreKeySignature ?? "", "base64").length === 64,
    );
    const edPub = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: aliceKeys.signingPublicRaw.toString("base64url") },
      format: "jwk",
    });
    check(
      "signed-prekey signature verifies against signing key",
      edVerify(
        null,
        Buffer.from(bundle?.signedPreKey ?? "", "base64"),
        edPub,
        Buffer.from(bundle?.signedPreKeySignature ?? "", "base64"),
      ),
    );
    check(
      "one-time prekey came from Alice's uploaded set",
      otps1.some((k) => k.publicKey === bundle?.oneTimePreKey && k.keyId === bundle?.oneTimePreKeyId),
    );

    console.log("\n[5] One-time prekeys are single-use");
    const b2 = await api(`/bundle/${alice.deviceId}`, bob.token);
    check(
      "second fetch returns a different one-time key",
      b2.status === 200 && b2.json?.oneTimePreKey && b2.json.oneTimePreKey !== bundle?.oneTimePreKey,
    );
    const cnt = await api("/count", alice.token);
    check("count shows 3 remaining", cnt.json?.oneTimePreKeysRemaining === 3, cnt);

    console.log("\n[6] Concurrency: 20 simultaneous fetches, no duplicates");
    await api("/upload", alice.token, "POST", { oneTimePreKeys: newOtps(20) });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => api(`/bundle/${alice.deviceId}`, bob.token)),
    );
    const got = results.map((r) => r.json?.oneTimePreKey).filter(Boolean) as string[];
    check("all 20 requests succeeded", results.every((r) => r.status === 200));
    check("20 distinct one-time keys handed out", new Set(got).size === 20 && got.length === 20, {
      got: got.length,
      distinct: new Set(got).size,
    });

    console.log("\n[7] Fallback when one-time keys run out");
    const left = (await api("/count", alice.token)).json?.oneTimePreKeysRemaining as number;
    check("3 unused keys left before draining", left === 3, left);
    for (let i = 0; i < left; i++) await api(`/bundle/${alice.deviceId}`, bob.token);
    const dry = await api(`/bundle/${alice.deviceId}`, bob.token);
    check("bundle still returned with no one-time keys (200)", dry.status === 200, dry);
    check("fallback bundle has no oneTimePreKey", dry.json && !("oneTimePreKey" in dry.json));
    check("fallback bundle still has signed prekey + signature", !!dry.json?.signedPreKey && !!dry.json?.signedPreKeySignature);
    const cnt2 = await api("/count", alice.token);
    check(
      "count -> 0 remaining, needsReplenishment true",
      cnt2.json?.oneTimePreKeysRemaining === 0 && cnt2.json?.needsReplenishment === true,
      cnt2,
    );

    console.log("\n[8] Signed prekey rotation");
    const newSpk = makeDeviceKeys();
    const rot = await api("/upload", alice.token, "POST", {
      signedPreKey: {
        keyId: 2,
        publicKey: newSpk.signedPreKey.publicKey,
        signature: b64(edSign(null, Buffer.from(newSpk.signedPreKey.publicKey, "base64"), aliceKeys.signing.privateKey)),
      },
    });
    check("rotate signed prekey -> 200", rot.status === 200, rot);
    const b3 = await api(`/bundle/${alice.deviceId}`, bob.token);
    check("bundle now serves the new signed prekey", b3.json?.signedPreKey === newSpk.signedPreKey.publicKey);
    const top = await pool.query(`SELECT max(key_id)::int AS k FROM signed_prekeys WHERE device_id = $1`, [alice.deviceId]);
    check("highest signed key_id is 2", top.rows[0].k === 2, top.rows[0]);
    const stale = await api("/upload", alice.token, "POST", {
      signedPreKey: { keyId: 2, publicKey: newSpk.signedPreKey.publicKey, signature: newSpk.signedPreKey.signature },
    });
    check("re-using a signed key_id -> 409", stale.status === 409, stale);

    console.log("\n[9] Device with placeholder key is not served");
    check("Bob (never uploaded keys) -> 404", (await api(`/bundle/${bob.deviceId}`, alice.token)).status === 404);
  } finally {
    if (deviceIds.length) {
      await pool.query(`DELETE FROM one_time_prekeys WHERE device_id = ANY($1::uuid[])`, [deviceIds]);
      await pool.query(`DELETE FROM signed_prekeys WHERE device_id = ANY($1::uuid[])`, [deviceIds]);
      await pool.query(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [deviceIds]);
    }
    if (userIds.length) {
      await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
    }
    const after = await pool.query(
      `SELECT (SELECT count(*)::int FROM signed_prekeys) AS s, (SELECT count(*)::int FROM one_time_prekeys) AS o`,
    );
    console.log(
      `\nExisting rows before/after: signed ${before.rows[0].s}/${after.rows[0].s}, one-time ${before.rows[0].o}/${after.rows[0].o}`,
    );
    await new Promise<void>((r) => io.close(() => r()));
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});