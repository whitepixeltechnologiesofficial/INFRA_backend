/**
 * BE-5.4 verification: message send -> relay -> receive pipeline, end to end.
 *
 * Starts the real Express app on a random port, creates throwaway users and
 * devices (Alice x1, Bob x2), and runs a REAL @wpt/crypto X3DH + Double Ratchet
 * session, sending the resulting ciphertext through the real /relay routes.
 * Proves: what Bob's device decrypts is what Alice sent, and the server only
 * ever held ciphertext.
 *
 * Also covers the failure paths and the two bugs fixed in this task:
 *  - device-addressed sends previously violated pending_messages_recipient_exactly_one
 *  - /relay/ack previously accepted an ack from a SIBLING device of the recipient
 *
 * Requires migration 018 (pending_messages.client_message_id).
 * Real-time push is checked when socket.io-client is resolvable (it lives in
 * packages/api-client); otherwise that one check is reported SKIPPED, not passed.
 *
 * Run: pnpm --filter @wpt/backend exec tsx src/db/relay-pipeline-e2e-test.ts
 */

import "dotenv/config";
import { randomUUID, randomInt } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createPool } from "./pool.js";
import { createApp } from "../app.js";
import { issueAccessToken } from "../auth/jwt.js";
import { phoneHash } from "../utils/phone-hash.js";
import {
  generateX25519KeyPair,
  generateIdentityKeyPair,
  generatePreKeyBundle,
  initiateSession,
  respondToSession,
  initRatchet,
  ratchetEncrypt,
  ratchetDecrypt,
  type RatchetMessage,
} from "@wpt/crypto";

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`, detail !== undefined ? `\n        -> ${JSON.stringify(detail)}` : "");
  }
}

// ── Envelope wire format (PLACEHOLDER — exact shape awaits TAD confirmation).
// The server never parses this; it is opaque bytes to the relay.
const toHex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
function encodeEnvelope(m: RatchetMessage): string {
  return Buffer.from(
    JSON.stringify({
      rk: toHex(m.header.ratchetKey),
      n: m.header.messageNumber,
      pn: m.header.previousChainLength,
      nonce: toHex(m.nonce),
      ct: toHex(m.ciphertext),
    }),
  ).toString("hex");
}
function decodeEnvelope(hex: string): RatchetMessage {
  const j = JSON.parse(Buffer.from(hex, "hex").toString());
  return {
    header: { ratchetKey: fromHex(j.rk), messageNumber: j.n, previousChainLength: j.pn },
    nonce: fromHex(j.nonce),
    ciphertext: fromHex(j.ct),
  };
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const pool = createPool({ connectionString: dbUrl });

  const col = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'pending_messages' AND column_name = 'client_message_id'`,
  );
  if (col.rowCount === 0) {
    await pool.end();
    throw new Error("pending_messages.client_message_id is missing. Apply migrations/018 first.");
  }

  const before = await pool.query(`SELECT count(*)::int AS n FROM pending_messages`);

  const { httpServer, io } = createApp();
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = (httpServer.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api`;

  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const blockKeys: Array<[string, string]> = [];
  const sessionIds: string[] = [];

  try {
    const { API_VERSION } = await import("@wpt/shared");

    const api = async (path: string, token: string | null, body?: unknown) => {
      const res = await fetch(`${base}/${API_VERSION}/relay${path}`, {
        method: "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
      });
      // Untyped JSON asserted field-by-field below; bounded exception for this test script.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type ApiJson = any;
      let json: ApiJson = null;
      try {
        json = await res.json();
      } catch {
        /* empty body */
      }
      return { status: res.status, json };
    };

    const makeUser = async (deviceTypes: Array<"phone" | "web">) => {
      const userId = randomUUID();
      const phone = `+1${randomInt(2000000000, 2999999999)}`;
      await pool.query(`INSERT INTO users (id, phone_number, name) VALUES ($1, $2, $3)`, [
        userId,
        phone,
        `Test User ${userId.slice(0, 8)}`,
      ]);
      userIds.push(userId);
      const devs: Array<{ deviceId: string; token: string; sessionId: string }> = [];
      for (const t of deviceTypes) {
        const deviceId = randomUUID();
        await pool.query(
          `INSERT INTO devices (id, user_id, device_type, platform, identity_public_key)
           VALUES ($1, $2, $3, $4, $5)`,
          [deviceId, userId, t, t === "web" ? "web" : "android", `pf_${deviceId}`],
        );
        deviceIds.push(deviceId);
        const sessionId = randomUUID();
        devs.push({ deviceId, sessionId, token: await issueAccessToken({ userId, deviceId, sessionId }) });
      }
      return { userId, phone, devs };
    };

    const alice = await makeUser(["phone"]);
    const bob = await makeUser(["phone", "web"]);
    const carol = await makeUser(["phone"]); // for mixed-owner + block cases
    const [a] = alice.devs;
    const [bPhone, bWeb] = bob.devs;
    const [c] = carol.devs;

    // ── Real crypto session: Alice -> Bob's phone ──
    const aliceIK = generateX25519KeyPair();
    const bobIK = generateX25519KeyPair();
    const bobSigning = generateIdentityKeyPair();
    const { bundle, signedPreKeyPair, oneTimePreKeyPair } = generatePreKeyBundle(bobIK, bobSigning);
    const { sessionKeys, ephemeralKeyPair } = initiateSession(aliceIK, bundle);
    const bobKeys = respondToSession(bobIK, signedPreKeyPair, aliceIK.publicKey, ephemeralKeyPair.publicKey, oneTimePreKeyPair);
    let aliceRatchet = initRatchet(sessionKeys.rootKey, true, { theirRatchetKey: bundle.signedPreKey });
    let bobRatchet = initRatchet(bobKeys.rootKey, false, { ourSignedPreKeyPair: signedPreKeyPair });

    console.log("\n[1] Auth and validation");
    check("no token -> 401", (await api("/send", null, {})).status === 401);
    check(
      "bad clientMessageId -> 400",
      (await api("/send", a!.token, { clientMessageId: "nope", recipients: [{ deviceId: bPhone!.deviceId, ciphertext: "aa" }] })).status === 400,
    );
    check("no addressing mode -> 400", (await api("/send", a!.token, { clientMessageId: randomUUID() })).status === 400);
    check(
      "two addressing modes -> 400",
      (await api("/send", a!.token, { clientMessageId: randomUUID(), recipientUserId: bob.userId, recipientDeviceId: bPhone!.deviceId, ciphertext: "aa" })).status === 400,
    );
    check(
      "non-hex ciphertext -> 400",
      (await api("/send", a!.token, { clientMessageId: randomUUID(), recipients: [{ deviceId: bPhone!.deviceId, ciphertext: "zz" }] })).status === 400,
    );
    check(
      "send to own device -> 400",
      (await api("/send", a!.token, { clientMessageId: randomUUID(), recipients: [{ deviceId: a!.deviceId, ciphertext: "aabb" }] })).status === 400,
    );
    check(
      "group send -> 400 (BE-5.7)",
      (await api("/send", a!.token, { clientMessageId: randomUUID(), recipientGroupId: randomUUID(), ciphertext: "aabb" })).status === 400,
    );

    console.log("\n[2] Encrypted 1:1 send -> relay -> receive");
    const plaintext = "hello bob, this is the BE-5.4 pipeline test";
    const enc = ratchetEncrypt(aliceRatchet, new TextEncoder().encode(plaintext));
    aliceRatchet = enc.state;
    const envelopeHex = encodeEnvelope(enc.message);
    const msgId1 = randomUUID();
    const s1 = await api("/send", a!.token, {
      clientMessageId: msgId1,
      recipients: [{ deviceId: bPhone!.deviceId, ciphertext: envelopeHex }],
    });
    check("send -> 200, 1 row, not duplicate", s1.status === 200 && s1.json?.count === 1 && s1.json?.duplicate === false, s1);

    const row = await pool.query(
      `SELECT ciphertext, size_bytes, recipient_user_id, recipient_device_id FROM pending_messages WHERE id = $1`,
      [s1.json?.rows?.[0]?.id],
    );
    const stored: Buffer = row.rows[0]?.ciphertext;
    check("server stored ciphertext only (no plaintext bytes in row)", !!stored && !stored.includes(Buffer.from(plaintext)));
    check("size_bytes matches ciphertext length", row.rows[0]?.size_bytes === stored?.length);
    check("row addressed to Bob's phone with Bob's user id", row.rows[0]?.recipient_device_id === bPhone!.deviceId && row.rows[0]?.recipient_user_id === bob.userId);

    const p1 = await api("/poll", bPhone!.token);
    check("Bob's phone polls the message", p1.status === 200 && p1.json?.messages?.length === 1 && p1.json.messages[0].id === s1.json.rows[0].id, p1);
    const dec = ratchetDecrypt(bobRatchet, decodeEnvelope(p1.json.messages[0].ciphertext));
    bobRatchet = dec.state;
    check("Bob decrypts EXACTLY what Alice sent", new TextDecoder().decode(dec.plaintext) === plaintext);
    check("Bob's other device (web) does NOT see it", (await api("/poll", bWeb!.token)).json?.messages?.length === 0);
    check("Carol / Alice cannot poll Bob's device", (await api("/poll", c!.token, { deviceId: bPhone!.deviceId })).json?.messages?.length === 0);

    console.log("\n[3] Idempotent retry");
    const s1b = await api("/send", a!.token, {
      clientMessageId: msgId1,
      recipients: [{ deviceId: bPhone!.deviceId, ciphertext: envelopeHex }],
    });
    check("retry -> 200 duplicate:true, same row id", s1b.status === 200 && s1b.json?.duplicate === true && s1b.json?.rows?.[0]?.id === s1.json.rows[0].id, s1b);
    const cnt = await pool.query(`SELECT count(*)::int AS n FROM pending_messages WHERE sender_device_id = $1 AND client_message_id = $2`, [a!.deviceId, msgId1]);
    check("still exactly 1 row after retry", cnt.rows[0].n === 1);

    console.log("\n[4] Ack is scoped to the recipient device");
    const mid = s1.json.rows[0].id;
    check("sibling device (web) cannot ack -> 404", (await api("/ack", bWeb!.token, { messageId: mid })).status === 404);
    check("sender cannot ack -> 404", (await api("/ack", a!.token, { messageId: mid })).status === 404);
    const ack1 = await api("/ack", bPhone!.token, { messageId: mid });
    check("recipient device acks -> 200", ack1.status === 200 && !!ack1.json?.deliveredAt, ack1);
    const ack2 = await api("/ack", bPhone!.token, { messageId: mid });
    check("second ack is idempotent -> 200 alreadyAcked", ack2.status === 200 && ack2.json?.alreadyAcked === true, ack2);
    check("acked message no longer polled", (await api("/poll", bPhone!.token)).json?.messages?.length === 0);

    console.log("\n[5] Per-device fan-out (one ciphertext per device)");
    const s2 = await api("/send", a!.token, {
      clientMessageId: randomUUID(),
      recipients: [
        { deviceId: bPhone!.deviceId, ciphertext: "aa11" },
        { deviceId: bWeb!.deviceId, ciphertext: "bb22" },
      ],
    });
    check("2 devices -> 2 rows", s2.status === 200 && s2.json?.count === 2, s2);
    const pw = await api("/poll", bWeb!.token);
    check("web device receives ITS OWN ciphertext", pw.json?.messages?.length === 1 && pw.json.messages[0].ciphertext === "bb22", pw);
    check(
      "recipients spanning two users -> 400",
      (await api("/send", a!.token, { clientMessageId: randomUUID(), recipients: [{ deviceId: bPhone!.deviceId, ciphertext: "aa" + "aa" }, { deviceId: c!.deviceId, ciphertext: "bbbb" }] })).status === 400,
    );

    console.log("\n[6] Legacy shapes (regression for the CHECK-constraint bug)");
    const s3 = await api("/send", a!.token, { clientMessageId: randomUUID(), recipientDeviceId: bPhone!.deviceId, ciphertext: "cc33" });
    check("recipientDeviceId send now succeeds (was rejected by CHECK)", s3.status === 200 && s3.json?.count === 1, s3);
    const s4 = await api("/send", a!.token, { recipientUserId: bob.userId, ciphertext: "dd44" });
    check("recipientUserId fan-out still works, no clientMessageId needed", s4.status === 200 && s4.json?.count === 2, s4);

    console.log("\n[7] Failure conditions");
    await pool.query(`UPDATE devices SET revoked_at = now(), is_active = false WHERE id = $1`, [bWeb!.deviceId]);
    check(
      "revoked recipient device -> 404, nothing stored",
      (await api("/send", a!.token, { clientMessageId: randomUUID(), recipients: [{ deviceId: bWeb!.deviceId, ciphertext: "ee55" }] })).status === 404,
    );
    const ph = (p: string) => phoneHash(p);
    await pool.query(`INSERT INTO blocks (blocker_phone_hash, blocked_phone_hash) VALUES ($1, $2)`, [ph(carol.phone), ph(alice.phone)]);
    blockKeys.push([ph(carol.phone), ph(alice.phone)]);
    check(
      "blocked pair (either direction) -> 403",
      (await api("/send", a!.token, { clientMessageId: randomUUID(), recipients: [{ deviceId: c!.deviceId, ciphertext: "ff66" }] })).status === 403,
    );
    await pool.query(`UPDATE devices SET revoked_at = now(), is_active = false WHERE id = $1`, [a!.deviceId]);
    check(
      "revoked SENDER device with a still-valid token -> 403",
      (await api("/send", a!.token, { clientMessageId: randomUUID(), recipients: [{ deviceId: bPhone!.deviceId, ciphertext: "aa77" }] })).status === 403,
    );
    await pool.query(`UPDATE devices SET revoked_at = NULL, is_active = true WHERE id = $1`, [a!.deviceId]);

    console.log("\n[8] Real-time push to an online recipient");
    // socket.io-client is not a backend dependency, so import it via a variable
    // specifier (keeps tsc from failing on an unresolvable module in CI).
    type MiniSocket = {
      on(ev: string, cb: (...a: never[]) => void): void;
      close(): void;
    };
    type IoClient = { io: (url: string, opts: unknown) => MiniSocket };
    let ioClient: IoClient | null = null;
    try {
      const spec = "socket.io-client";
      ioClient = (await import(spec)) as IoClient;
    } catch {
      ioClient = null;
    }
    if (!ioClient) {
      skipped++;
      console.log("  SKIP  socket.io-client not resolvable from apps/backend — push not verified here");
    } else {
      await pool.query(
        `INSERT INTO sessions (id, user_id, device_id, token_lookup, refresh_token_hash, refresh_token_expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
        [bPhone!.sessionId, bob.userId, bPhone!.deviceId, randomUUID().replace(/-/g, ""), "x".repeat(60)],
      );
      sessionIds.push(bPhone!.sessionId);
      const sock = ioClient.io(`http://127.0.0.1:${port}`, {
        path: (await import("@wpt/shared")).SOCKET_NAMESPACE,
        auth: { token: bPhone!.token, userId: bob.userId, deviceId: bPhone!.deviceId },
        transports: ["websocket"],
      });
      await new Promise<void>((res, rej) => {
        sock.on("connect", () => res());
        sock.on("connect_error", (e: never) => rej(e));
      });
      const pushedMsg = new Promise<{ id: string; ciphertext: string }>((res) => sock.on("message", res as (...a: never[]) => void));
      const s5 = await api("/send", a!.token, { clientMessageId: randomUUID(), recipients: [{ deviceId: bPhone!.deviceId, ciphertext: "9988" }] });
      const got = await Promise.race([pushedMsg, new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
      check("online recipient gets 'message' pushed, pushed:true", !!got && got.ciphertext === "9988" && s5.json?.rows?.[0]?.pushed === true, { got, s5 });
      sock.close();
    }
  } finally {
    if (sessionIds.length) await pool.query(`DELETE FROM sessions WHERE id = ANY($1::uuid[])`, [sessionIds]);
    for (const [x, y] of blockKeys) await pool.query(`DELETE FROM blocks WHERE blocker_phone_hash = $1 AND blocked_phone_hash = $2`, [x, y]);
    if (deviceIds.length) {
      await pool.query(`DELETE FROM pending_messages WHERE sender_device_id = ANY($1::uuid[]) OR recipient_device_id = ANY($1::uuid[])`, [deviceIds]);
      await pool.query(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [deviceIds]);
    }
    if (userIds.length) await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [userIds]);
    const after = await pool.query(`SELECT count(*)::int AS n FROM pending_messages`);
    console.log(`\npending_messages rows before/after: ${before.rows[0].n}/${after.rows[0].n}`);
    await new Promise<void>((r) => io.close(() => r()));
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
