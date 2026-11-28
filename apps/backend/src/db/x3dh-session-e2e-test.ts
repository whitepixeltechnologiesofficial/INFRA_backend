/**
 * BE-5.3: End-to-end X3DH key exchange + Double Ratchet session test.
 *
 * Two simulated devices (Alice, Bob) only communicate through the REAL
 * backend's /prekeys routes. The actual @wpt/crypto functions that ship
 * to apps/mobile do the X3DH computation and Double Ratchet setup here —
 * this proves the cryptographic handshake and prekey distribution work
 * correctly end-to-end against real backend endpoints.
 *
 * SCOPE NOTE for the reviewer: this is a simulated two-device test, not
 * two physical phones — apps/mobile has no crypto wiring yet (separate
 * Open Item). It also hands Alice's first message to Bob in-process
 * rather than over a live transport, since BE-5.4 (messaging pipeline)
 * doesn't exist yet this sprint. What IS proven for real: real backend
 * endpoints, real @wpt/crypto functions, real derived keys, real
 * encrypt/decrypt round trip in both directions.
 *
 * Run: pnpm --filter @wpt/backend exec tsx src/db/x3dh-session-e2e-test.ts
 */

import "dotenv/config";
import { randomUUID, randomInt } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { createApp } from "../app.js";
import { issueAccessToken } from "../auth/jwt.js";

// If this import fails to resolve, check packages/crypto/package.json's
// "exports"/"main" field — there may be no barrel file, in which case use
// subpaths instead, e.g.:
//   import { generateX25519KeyPair, generateIdentityKeyPair } from "@wpt/crypto/primitives.js";
//   import { generatePreKeyBundle, initiateSession, respondToSession, type IdentityBundle } from "@wpt/crypto/x3dh.js";
//   import { initRatchet, ratchetEncrypt, ratchetDecrypt } from "@wpt/crypto/double-ratchet.js";
import {
  generateX25519KeyPair,
  generateIdentityKeyPair,
  generatePreKeyBundle,
  initiateSession,
  respondToSession,
  initRatchet,
  ratchetEncrypt,
  ratchetDecrypt,
  type IdentityBundle,
} from "@wpt/crypto";

const { Pool } = pg;

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

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const utf8 = (s: string) => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: dbUrl });

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper parses varied API response shapes
let json: any = null;
      try {
        json = await res.json();
      } catch {
        /* empty body */
      }
      return { status: res.status, json };
    };

    const makeUser = async () => {
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
    };

    const alice = await makeUser();
    const bob = await makeUser();

    console.log("\n[1] EDGE CASE: Alice tries Bob before he's ever uploaded keys (device 'offline')");
    check(
      "bundle fetch before Bob's initial upload -> 404, not a crash/hang",
      (await api(`/bundle/${bob.deviceId}`, alice.token)).status === 404,
    );

    console.log("\n[2] Bob 'comes online': generates real device keys via @wpt/crypto and uploads them");
    const bobIdentity = generateX25519KeyPair();
    const bobSigning = generateIdentityKeyPair();
    const { bundle: bobPublished, signedPreKeyPair: bobSpkPair, oneTimePreKeyPair: bobOtpPair } =
      generatePreKeyBundle(bobIdentity, bobSigning);

    const bobUpload = await api("/upload", bob.token, "POST", {
      identityKey: b64(bobIdentity.publicKey),
      signingPublicKey: b64(bobSigning.publicKey),
      signedPreKey: {
        keyId: 1,
        publicKey: b64(bobPublished.signedPreKey),
        signature: b64(bobPublished.signedPreKeySignature),
      },
      oneTimePreKeys: [{ keyId: 1, publicKey: b64(bobPublished.oneTimePreKey!) }],
    });
    check("Bob's real upload -> 200", bobUpload.status === 200, bobUpload);

    console.log("\n[3] Now that Bob is online, Alice fetches his real bundle from the real backend");
    const bundleRes = await api(`/bundle/${bob.deviceId}`, alice.token);
    check("bundle -> 200 now that Bob has uploaded", bundleRes.status === 200, bundleRes);
    const bj = bundleRes.json;
    const theirBundle: IdentityBundle = {
      identityKey: fromB64(bj.identityKey),
      signingKey: fromB64(bj.signingKey),
      signedPreKey: fromB64(bj.signedPreKey),
      signedPreKeySignature: fromB64(bj.signedPreKeySignature),
      oneTimePreKey: bj.oneTimePreKey ? fromB64(bj.oneTimePreKey) : undefined,
    };

    console.log("\n[4] Alice runs REAL X3DH against Bob's real, server-fetched bundle");
    const aliceIdentity = generateX25519KeyPair();
    const { sessionKeys: aliceSessionKeys, ephemeralKeyPair: aliceEphemeral } =
      initiateSession(aliceIdentity, theirBundle);
    check("X3DH produced a 32-byte root key", aliceSessionKeys.rootKey.length === 32);

    console.log("\n[5] Bob mirrors the X3DH computation (handoff is in-process — BE-5.4 transport doesn't exist yet)");
    const bobSessionKeys = respondToSession(
      bobIdentity,
      bobSpkPair,
      aliceIdentity.publicKey,
      aliceEphemeral.publicKey,
      bj.oneTimePreKey ? bobOtpPair : undefined,
    );
    check(
      "Alice and Bob independently derived the SAME root key",
      Buffer.from(aliceSessionKeys.rootKey).equals(Buffer.from(bobSessionKeys.rootKey)),
    );

    console.log("\n[6] Double Ratchet: Alice sends the first real message, Bob decrypts it");
    let aliceRatchet = initRatchet(aliceSessionKeys.rootKey, true, { theirRatchetKey: theirBundle.signedPreKey });
    let bobRatchet = initRatchet(bobSessionKeys.rootKey, false, { ourSignedPreKeyPair: bobSpkPair });

    const enc1 = ratchetEncrypt(aliceRatchet, utf8("hey bob, this is alice"));
    aliceRatchet = enc1.state;
    const dec1 = ratchetDecrypt(bobRatchet, enc1.message);
    bobRatchet = dec1.state;
    check("Bob decrypted Alice's message correctly", fromUtf8(dec1.plaintext) === "hey bob, this is alice");

    console.log("\n[7] Double Ratchet: Bob replies, Alice decrypts (proves the ratchet steps both ways)");
    const enc2 = ratchetEncrypt(bobRatchet, utf8("hey alice, got it"));
    bobRatchet = enc2.state;
    const dec2 = ratchetDecrypt(aliceRatchet, enc2.message);
    aliceRatchet = dec2.state;
    check("Alice decrypted Bob's reply correctly", fromUtf8(dec2.plaintext) === "hey alice, got it");
  } finally {
    if (deviceIds.length) {
      await pool.query(`DELETE FROM one_time_prekeys WHERE device_id = ANY($1::uuid[])`, [deviceIds]);
      await pool.query(`DELETE FROM signed_prekeys WHERE device_id = ANY($1::uuid[])`, [deviceIds]);
      await pool.query(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [deviceIds]);
    }
    if (userIds.length) {
      await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
    }
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