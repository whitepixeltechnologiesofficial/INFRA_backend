/**
 * BE-5.6 verification: offline recipient queuing and automatic delivery on reconnect.
 *
 * Starts the real Express + socket.io app on a random port, creates throwaway
 * users/devices (Alice x1, Bob phone + web), and drives the real /relay routes
 * and real socket connections:
 *   [1] sends to an offline device queue durably; sender status stays `sent`
 *   [2] reconnect pushes the queue automatically, oldest first, nothing marked delivered yet
 *   [3] /relay/ack moves status sent -> delivered, and the live sender is told
 *   [4] an acked queue is not re-sent on the next connect
 *   [5] unacked messages (connection dropped before ack) are re-sent, not lost
 *   [6] expired rows are not delivered; offline is not a failure (status stays `sent`)
 *   [7] a blocked sender's queued message is not delivered (DB-2.4 parity with /relay/poll)
 *   [8] a backlog larger than one batch arrives complete, in order, no duplicates
 *       (includes rows with identical created_at, to exercise the (created_at, id) cursor)
 *   [9] multi-device: only the reconnecting device's rows drain; the sibling's stay queued
 *
 * Requires migrations 018 and 019 and socket.io-client resolvable from apps/backend.
 * Run: pnpm --filter @wpt/backend exec tsx src/db/offline-queue-e2e-test.ts
 */

import "dotenv/config";
import { randomUUID, randomInt } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createPool } from "./pool.js";
import { createApp } from "../app.js";
import { issueAccessToken } from "../auth/jwt.js";
import { phoneHash } from "../utils/phone-hash.js";
import { getConnectionCount } from "../ws/socket-registry.js";
import { DRAIN_BATCH_SIZE } from "../ws/offline-drain.js";

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

type Handler = (...a: never[]) => void;
type MiniSocket = { on(ev: string, cb: Handler): void; close(): void };
type IoClient = { io: (url: string, opts: unknown) => MiniSocket };
type Msg = { id: string; senderDeviceId: string; ciphertext: string; clientMessageId: string | null };
type StatusEv = { clientMessageId: string; state: string };

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const pool = createPool({ connectionString: dbUrl });

  for (const [table, column] of [
    ["pending_messages", "client_message_id"],
    ["message_status", "state"],
  ] as const) {
    const col = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, column],
    );
    if (col.rowCount === 0) {
      await pool.end();
      throw new Error(`${table}.${column} is missing. Apply migrations 018 and 019 first.`);
    }
  }

  let ioClient: IoClient;
  try {
    const spec = "socket.io-client"; // variable specifier: not a backend dependency, keeps tsc happy in CI
    ioClient = (await import(spec)) as IoClient;
  } catch {
    await pool.end();
    throw new Error("socket.io-client is not resolvable from apps/backend. This test needs real sockets; it cannot skip.");
  }

  const before = await pool.query(`SELECT count(*)::int AS n FROM pending_messages`);

  const { httpServer, io } = createApp();
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = (httpServer.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api`;
  const { API_VERSION, SOCKET_NAMESPACE } = await import("@wpt/shared");

  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const sessionIds: string[] = [];
  const blockKeys: Array<[string, string]> = [];
  const openSockets: MiniSocket[] = [];

  try {
    const api = async (path: string, token: string, body?: unknown) => {
      const res = await fetch(`${base}/${API_VERSION}/relay${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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

    type Dev = { deviceId: string; token: string; sessionId: string };
    const makeUser = async (deviceTypes: Array<"phone" | "web">) => {
      const userId = randomUUID();
      const phone = `+1${randomInt(2000000000, 2999999999)}`;
      await pool.query(`INSERT INTO users (id, phone_number, name) VALUES ($1, $2, $3)`, [
        userId,
        phone,
        `Test User ${userId.slice(0, 8)}`,
      ]);
      userIds.push(userId);
      const devs: Dev[] = [];
      for (const t of deviceTypes) {
        const deviceId = randomUUID();
        await pool.query(
          `INSERT INTO devices (id, user_id, device_type, platform, identity_public_key) VALUES ($1, $2, $3, $4, $5)`,
          [deviceId, userId, t, t === "web" ? "web" : "android", `pf_${deviceId}`],
        );
        deviceIds.push(deviceId);
        const sessionId = randomUUID();
        // The socket handshake checks the session row, so every connecting device needs one.
        await pool.query(
          `INSERT INTO sessions (id, user_id, device_id, token_lookup, refresh_token_hash, refresh_token_expires_at)
           VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
          [sessionId, userId, deviceId, randomUUID().replace(/-/g, ""), "x".repeat(60)],
        );
        sessionIds.push(sessionId);
        devs.push({ deviceId, sessionId, token: await issueAccessToken({ userId, deviceId, sessionId }) });
      }
      return { userId, phone, devs };
    };

    const alice = await makeUser(["phone"]);
    const bob = await makeUser(["phone", "web"]);
    const [a] = alice.devs;
    const [bPhone, bWeb] = bob.devs;

    /** Connect a device; listeners are attached before any event can arrive. */
    const connect = async (d: Dev, userId: string) => {
      const sock = ioClient.io(`http://127.0.0.1:${port}`, {
        path: SOCKET_NAMESPACE,
        auth: { token: d.token, userId, deviceId: d.deviceId },
        transports: ["websocket"],
        reconnection: false,
      });
      openSockets.push(sock);
      const messages: Msg[] = [];
      const statuses: StatusEv[] = [];
      sock.on("message", ((m: Msg) => messages.push(m)) as Handler);
      sock.on("message_status", ((s: StatusEv) => statuses.push(s)) as Handler);
      await new Promise<void>((res, rej) => {
        sock.on("connect", (() => res()) as Handler);
        sock.on("connect_error", ((e: never) => rej(e)) as Handler);
      });
      return { sock, messages, statuses };
    };
    /** Close and wait until the server has unregistered it, so the next send is truly "offline". */
    const goOffline = async (c: { sock: MiniSocket }, userId: string) => {
      c.sock.close();
      await waitFor(() => getConnectionCount(userId) === 0);
    };

    const hex = (s: string) => Buffer.from(s).toString("hex");
    const send = (token: string, clientMessageId: string, devs: Array<{ d: Dev; ct: string }>) =>
      api("/send", token, {
        clientMessageId,
        recipients: devs.map(({ d, ct }) => ({ deviceId: d.deviceId, ciphertext: hex(ct) })),
      });
    const undelivered = async (deviceId: string) =>
      (await pool.query(
        `SELECT count(*)::int AS n FROM pending_messages WHERE recipient_device_id = $1 AND delivered_at IS NULL`,
        [deviceId],
      )).rows[0].n as number;
    const statusOf = async (ids: string[]) => {
      const r = await api("/status/sync", a!.token, { clientMessageIds: ids });
      const m = new Map<string, string>();
      for (const s of (r.json?.statuses ?? []) as StatusEv[]) m.set(s.clientMessageId, s.state);
      return m;
    };

    // Alice stays online so she can receive live status pushes.
    const aliceConn = await connect(a!, alice.userId);

    console.log("\n[1] Send to an offline device queues durably");
    const ids1 = [randomUUID(), randomUUID(), randomUUID()];
    const rowIds1: string[] = [];
    let allQueuedNotPushed = true;
    for (const [i, cmid] of ids1.entries()) {
      const s = await send(a!.token, cmid, [{ d: bPhone!, ct: `queued-${i}` }]);
      rowIds1.push(s.json?.rows?.[0]?.id);
      if (s.status !== 200 || s.json?.rows?.[0]?.pushed !== false) allQueuedNotPushed = false;
      await sleep(5); // distinct created_at so the expected order is unambiguous
    }
    check("3 sends accepted, pushed:false (recipient offline)", allQueuedNotPushed);
    check("3 undelivered rows queued for Bob's phone", (await undelivered(bPhone!.deviceId)) === 3);
    const st1 = await statusOf(ids1);
    check("sender status is `sent` for all 3", ids1.every((id) => st1.get(id) === "sent"), [...st1]);

    console.log("\n[2] Reconnect delivers the queue automatically, oldest first");
    const bob1 = await connect(bPhone!, bob.userId);
    await waitFor(() => bob1.messages.length >= 3);
    await sleep(500);
    check("exactly 3 messages pushed on connect (no poll needed)", bob1.messages.length === 3, bob1.messages.length);
    check("in send order", JSON.stringify(bob1.messages.map((m) => m.id)) === JSON.stringify(rowIds1));
    check(
      "ciphertext and clientMessageId intact",
      bob1.messages.every((m, i) => m.ciphertext === hex(`queued-${i}`) && m.clientMessageId === ids1[i]),
    );
    check("not marked delivered until the client acks", (await undelivered(bPhone!.deviceId)) === 3);
    const st2 = await statusOf(ids1);
    check("sender status still `sent` before ack", ids1.every((id) => st2.get(id) === "sent"));

    console.log("\n[3] Ack moves status sent -> delivered and notifies the live sender");
    let acksOk = true;
    for (const m of bob1.messages) {
      const r = await api("/ack", bPhone!.token, { messageId: m.id });
      if (r.status !== 200 || r.json?.success !== true) acksOk = false;
    }
    check("3 acks succeed", acksOk);
    const st3 = await statusOf(ids1);
    check("sender status `delivered` for all 3", ids1.every((id) => st3.get(id) === "delivered"), [...st3]);
    await waitFor(() => aliceConn.statuses.filter((s) => s.state === "delivered").length >= 3);
    check(
      "Alice's live socket got 3 `delivered` pushes",
      ids1.every((id) => aliceConn.statuses.some((s) => s.clientMessageId === id && s.state === "delivered")),
      aliceConn.statuses,
    );
    check("queue is empty", (await undelivered(bPhone!.deviceId)) === 0);

    console.log("\n[4] An acked queue is not re-sent");
    await goOffline(bob1, bob.userId);
    const bob2 = await connect(bPhone!, bob.userId);
    await sleep(800);
    check("reconnect delivers nothing", bob2.messages.length === 0, bob2.messages.length);
    await goOffline(bob2, bob.userId);

    console.log("\n[5] Dropped before ack: re-sent on next reconnect, nothing lost");
    const ids5 = [randomUUID(), randomUUID()];
    const rowIds5: string[] = [];
    for (const [i, cmid] of ids5.entries()) {
      rowIds5.push((await send(a!.token, cmid, [{ d: bPhone!, ct: `retry-${i}` }])).json?.rows?.[0]?.id);
      await sleep(5);
    }
    const bob3 = await connect(bPhone!, bob.userId);
    await waitFor(() => bob3.messages.length >= 2);
    check("first connect receives both", bob3.messages.length === 2);
    await goOffline(bob3, bob.userId); // dropped WITHOUT acking
    check("rows still queued after the drop", (await undelivered(bPhone!.deviceId)) === 2);
    const bob4 = await connect(bPhone!, bob.userId);
    await waitFor(() => bob4.messages.length >= 2);
    await sleep(400);
    check(
      "second connect receives the same 2, in order, no extras",
      JSON.stringify(bob4.messages.map((m) => m.id)) === JSON.stringify(rowIds5),
      bob4.messages.map((m) => m.id),
    );
    for (const m of bob4.messages) await api("/ack", bPhone!.token, { messageId: m.id });
    const st5 = await statusOf(ids5);
    check("status `delivered` after ack", ids5.every((id) => st5.get(id) === "delivered"));
    await goOffline(bob4, bob.userId);
    const bob5 = await connect(bPhone!, bob.userId);
    await sleep(600);
    check("nothing left to deliver after ack", bob5.messages.length === 0);
    await goOffline(bob5, bob.userId);

    console.log("\n[6] Expired rows are not delivered; offline is not a failure");
    const id6 = randomUUID();
    await send(a!.token, id6, [{ d: bPhone!, ct: "expired" }]);
    await pool.query(`UPDATE pending_messages SET expires_at = now() - interval '1 minute' WHERE client_message_id = $1`, [id6]);
    const bob6 = await connect(bPhone!, bob.userId);
    await sleep(800);
    check("expired message not pushed", bob6.messages.length === 0, bob6.messages.length);
    check("status stays `sent` (not failed) — only the sender can report failure", (await statusOf([id6])).get(id6) === "sent");
    await goOffline(bob6, bob.userId);
    await pool.query(`DELETE FROM pending_messages WHERE client_message_id = $1`, [id6]);

    console.log("\n[7] A blocked sender's queued message is not delivered");
    const id7 = randomUUID();
    await send(a!.token, id7, [{ d: bPhone!, ct: "from-blocked" }]);
    const ph = (p: string) => phoneHash(p);
    await pool.query(`INSERT INTO blocks (blocker_phone_hash, blocked_phone_hash) VALUES ($1, $2)`, [ph(bob.phone), ph(alice.phone)]);
    blockKeys.push([ph(bob.phone), ph(alice.phone)]);
    const bob7 = await connect(bPhone!, bob.userId);
    await sleep(800);
    check("blocked partner's message not pushed", bob7.messages.length === 0, bob7.messages.length);
    await goOffline(bob7, bob.userId);
    await pool.query(`DELETE FROM blocks WHERE blocker_phone_hash = $1 AND blocked_phone_hash = $2`, [ph(bob.phone), ph(alice.phone)]);
    await pool.query(`DELETE FROM pending_messages WHERE client_message_id = $1`, [id7]);

    console.log(`\n[8] Backlog larger than one batch (batch size ${DRAIN_BATCH_SIZE})`);
    const N = 120;
    await pool.query(
      `INSERT INTO pending_messages
         (sender_device_id, recipient_device_id, recipient_user_id, ciphertext, message_type, size_bytes, expires_at, created_at, client_message_id)
       SELECT $1, $2, $3, decode('aabb', 'hex'), 'text', 2, now() + interval '1 day',
              now() - interval '1 hour' + (i / 10) * interval '1 millisecond', gen_random_uuid()
         FROM generate_series(0, $4::int - 1) AS i`,
      [a!.deviceId, bPhone!.deviceId, bob.userId, N],
    );
    const expected = (
      await pool.query(
        `SELECT id FROM pending_messages WHERE recipient_device_id = $1 AND delivered_at IS NULL ORDER BY created_at, id`,
        [bPhone!.deviceId],
      )
    ).rows.map((r: { id: string }) => r.id);
    check(`${N} rows queued (10 share each created_at)`, expected.length === N, expected.length);
    const bob8 = await connect(bPhone!, bob.userId);
    await waitFor(() => bob8.messages.length >= N, 10000);
    await sleep(500);
    const got8 = bob8.messages.map((m) => m.id);
    check(`all ${N} delivered, none extra`, got8.length === N, got8.length);
    check("no duplicates", new Set(got8).size === N);
    check("exact (created_at, id) order", JSON.stringify(got8) === JSON.stringify(expected));
    await goOffline(bob8, bob.userId);
    await pool.query(`DELETE FROM pending_messages WHERE recipient_device_id = $1`, [bPhone!.deviceId]);

    console.log("\n[9] Multi-device: only the reconnecting device's rows drain");
    const id9 = randomUUID();
    await send(a!.token, id9, [
      { d: bPhone!, ct: "for-phone" },
      { d: bWeb!, ct: "for-web" },
    ]);
    const bobP = await connect(bPhone!, bob.userId);
    await waitFor(() => bobP.messages.length >= 1);
    await sleep(500);
    check("phone gets exactly its own envelope", bobP.messages.length === 1 && bobP.messages[0]!.ciphertext === hex("for-phone"));
    await api("/ack", bPhone!.token, { messageId: bobP.messages[0]!.id });
    check("web's row still queued after phone acks", (await undelivered(bWeb!.deviceId)) === 1);
    check("status `delivered` once any device acks (BE-5.5 rule)", (await statusOf([id9])).get(id9) === "delivered");
    const bobW = await connect(bWeb!, bob.userId);
    await waitFor(() => bobW.messages.length >= 1);
    check("web later gets its own envelope", bobW.messages.length === 1 && bobW.messages[0]!.ciphertext === hex("for-web"));
    await api("/ack", bWeb!.token, { messageId: bobW.messages[0]!.id });
    check("both queues empty", (await undelivered(bPhone!.deviceId)) + (await undelivered(bWeb!.deviceId)) === 0);
  } finally {
    for (const s of openSockets) s.close();
    if (sessionIds.length) await pool.query(`DELETE FROM sessions WHERE id = ANY($1::uuid[])`, [sessionIds]);
    for (const [x, y] of blockKeys) await pool.query(`DELETE FROM blocks WHERE blocker_phone_hash = $1 AND blocked_phone_hash = $2`, [x, y]);
    if (deviceIds.length) {
      await pool.query(`DELETE FROM pending_messages WHERE sender_device_id = ANY($1::uuid[]) OR recipient_device_id = ANY($1::uuid[])`, [deviceIds]);
      await pool.query(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [deviceIds]);
    }
    if (userIds.length) await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
    const after = await pool.query(`SELECT count(*)::int AS n FROM pending_messages`);
    console.log(`\npending_messages rows before/after: ${before.rows[0].n}/${after.rows[0].n}`);
    await new Promise<void>((r) => io.close(() => r()));
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
