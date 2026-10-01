/**
 * BE-5.5 verification: four-state message status (sent / delivered / read / failed).
 *
 * Boots the real Express + Socket.IO app on a random port, creates throwaway
 * users/devices (Alice x1 sender, Bob x2 recipient phone+web, Carol x1 outsider)
 * and walks a message through its whole lifecycle under NORMAL and FAILURE
 * conditions, asserting both the database and what the sender is told.
 *
 * Requires migrations 018 and 019. Everything it creates is deleted afterwards.
 * Real-time push is checked when socket.io-client is resolvable; otherwise those
 * checks are reported SKIPPED, not passed.
 *
 * Run: pnpm --filter @wpt/backend exec tsx src/db/message-status-e2e-test.ts
 */

import "dotenv/config";
import { randomUUID, randomInt } from "node:crypto";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { createPool } from "./pool.js";
import { createApp } from "../app.js";
import { issueAccessToken } from "../auth/jwt.js";
import { phoneHash } from "../utils/phone-hash.js";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Untyped JSON asserted field-by-field below; bounded exception for this test script.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiJson = any;

type MiniSocket = {
  on(ev: string, cb: (...a: never[]) => void): void;
  close(): void;
};
type IoClient = { io: (url: string, opts: unknown) => MiniSocket };

async function loadSocketClient(): Promise<IoClient | null> {
  const attempts: Array<() => Promise<IoClient>> = [
    async () => (await import("socket.io-client")) as unknown as IoClient,
    async () => {
      const req = createRequire(new URL("../../../../packages/api-client/package.json", import.meta.url));
      return req("socket.io-client") as IoClient;
    },
  ];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch {
      /* try next */
    }
  }
  return null;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const pool = createPool({ connectionString: dbUrl });

  const need = await pool.query(
    `SELECT
       (SELECT count(*) FROM information_schema.columns WHERE table_name='pending_messages' AND column_name='client_message_id')::int AS m018,
       (SELECT count(*) FROM information_schema.tables  WHERE table_name='message_status')::int AS m019`,
  );
  if (need.rows[0].m018 === 0) throw new Error("Migration 018 (client_message_id) is missing.");
  if (need.rows[0].m019 === 0) throw new Error("Migration 019 (message_status) is missing.");

  const { httpServer, io } = createApp();
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = (httpServer.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api`;

  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const sessionIds: string[] = [];
  const blockKeys: Array<[string, string]> = [];
  const sockets: MiniSocket[] = [];

  try {
    const { API_VERSION, SOCKET_NAMESPACE } = await import("@wpt/shared");

    const post = async (path: string, token: string | null, body?: unknown) => {
      const res = await fetch(`${base}/${API_VERSION}/relay${path}`, {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
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
      await pool.query(`INSERT INTO users (id, phone_number, name) VALUES ($1, $2, $3)`, [userId, phone, `Test ${userId.slice(0, 8)}`]);
      userIds.push(userId);
      const devs: Array<{ deviceId: string; token: string; sessionId: string }> = [];
      for (const t of deviceTypes) {
        const deviceId = randomUUID();
        await pool.query(
          `INSERT INTO devices (id, user_id, device_type, platform, identity_public_key) VALUES ($1, $2, $3, $4, $5)`,
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
    const carol = await makeUser(["phone"]);
    const a = alice.devs[0]!;
    const bPhone = bob.devs[0]!;
    const bWeb = bob.devs[1]!;
    const c = carol.devs[0]!;

    const sendTo = (clientMessageId: string, hex = "aabbcc") =>
      post("/send", a.token, {
        clientMessageId,
        recipients: [
          { deviceId: bPhone.deviceId, ciphertext: hex },
          { deviceId: bWeb.deviceId, ciphertext: hex },
        ],
      });
    const statusRow = async (clientMessageId: string) =>
      (await pool.query(`SELECT * FROM message_status WHERE sender_device_id=$1 AND client_message_id=$2`, [a.deviceId, clientMessageId])).rows[0];
    const pendingFor = async (clientMessageId: string) =>
      (await pool.query(`SELECT id, recipient_device_id FROM pending_messages WHERE sender_device_id=$1 AND client_message_id=$2`, [a.deviceId, clientMessageId])).rows as Array<{ id: string; recipient_device_id: string }>;
    const syncOne = async (clientMessageId: string, token = a.token) =>
      (await post("/status/sync", token, { clientMessageIds: [clientMessageId] })).json?.statuses?.[0];
    const ackOn = async (dev: { token: string }, id: string) => post("/ack", dev.token, { messageId: id });

    console.log("\n[1] Auth and validation");
    check("read: no token -> 401", (await post("/status/read", null, {})).status === 401);
    check("failed: no token -> 401", (await post("/status/failed", null, {})).status === 401);
    check("sync: no token -> 401", (await post("/status/sync", null, {})).status === 401);
    check("read: bad senderDeviceId -> 400", (await post("/status/read", bPhone.token, { senderDeviceId: "x", clientMessageId: randomUUID() })).status === 400);
    check("read: bad clientMessageId -> 400", (await post("/status/read", bPhone.token, { senderDeviceId: a.deviceId, clientMessageId: "x" })).status === 400);
    check("failed: bad clientMessageId -> 400", (await post("/status/failed", a.token, { clientMessageId: "x" })).status === 400);
    check("failed: reason outside the closed set -> 400", (await post("/status/failed", a.token, { clientMessageId: randomUUID(), reason: "because" })).status === 400);
    check("sync: neither ids nor since -> 400", (await post("/status/sync", a.token, {})).status === 400);
    check("sync: bad since -> 400", (await post("/status/sync", a.token, { since: "not-a-date" })).status === 400);
    check("sync: > 200 ids -> 400", (await post("/status/sync", a.token, { clientMessageIds: Array.from({ length: 201 }, () => randomUUID()) })).status === 400);

    console.log("\n[2] SENT: normal send creates exactly one status row (fan-out to 2 devices)");
    const m1 = randomUUID();
    const s1 = await sendTo(m1);
    check("send ok, 2 queue rows", s1.status === 200 && s1.json?.count === 2, s1.json);
    check("response carries status.state = sent", s1.json?.status?.state === "sent" && s1.json?.status?.clientMessageId === m1, s1.json);
    const r1 = await statusRow(m1);
    check("exactly one message_status row for 2 recipient devices", (await pool.query(`SELECT count(*)::int n FROM message_status WHERE sender_device_id=$1 AND client_message_id=$2`, [a.deviceId, m1])).rows[0].n === 1);
    check("row is sent, no delivered/read/failed timestamps", r1?.state === "sent" && !r1.delivered_at && !r1.read_at && !r1.failed_at, r1);
    check("row stores recipient user + sender user, and NO ciphertext column", r1?.recipient_user_id === bob.userId && r1?.sender_user_id === alice.userId && !("ciphertext" in r1));
    check("expires_at is ~30 days out", r1 && Math.abs(new Date(r1.expires_at).getTime() - Date.now() - 30 * 86400_000) < 60_000);

    console.log("\n[3] FAILURE CONDITION - recipient offline is NOT a failure");
    check("no live socket for recipient: pushed=false on both rows", s1.json?.rows?.every((r: { pushed: boolean }) => r.pushed === false), s1.json?.rows);
    await sleep(300);
    check("status stays sent while recipient is offline", (await syncOne(m1))?.state === "sent");
    const polled = await post("/poll", bPhone.token, {});
    check("recipient reconnects and polls: sees the message", polled.json?.messages?.some((m: { clientMessageId: string }) => m.clientMessageId === m1));
    check("polling alone does not mark delivered (only the ack does)", (await syncOne(m1))?.state === "sent");

    console.log("\n[4] DELIVERED: ack from the first recipient device");
    const rows1 = await pendingFor(m1);
    const bPhoneRow = rows1.find((r) => r.recipient_device_id === bPhone.deviceId)!;
    const bWebRow = rows1.find((r) => r.recipient_device_id === bWeb.deviceId)!;
    const ack1 = await ackOn(bPhone, bPhoneRow.id);
    check("ack ok", ack1.status === 200 && ack1.json?.success === true, ack1.json);
    const d1 = await syncOne(m1);
    check("sender now sees delivered with delivered_at", d1?.state === "delivered" && !!d1?.deliveredAt && d1?.readAt === null, d1);
    const upd1 = (await statusRow(m1)).updated_at;
    const ackWeb = await ackOn(bWeb, bWebRow.id);
    check("sibling device ack ok", ackWeb.status === 200);
    const afterWeb = await statusRow(m1);
    check("second device ack does not change status (no double escalation)", afterWeb.state === "delivered" && +new Date(afterWeb.updated_at) === +new Date(upd1));
    check("re-acking an acked message is idempotent", (await ackOn(bPhone, bPhoneRow.id)).json?.alreadyAcked === true);

    console.log("\n[5] READ: recipient reports read");
    const readByOutsider = await post("/status/read", c.token, { senderDeviceId: a.deviceId, clientMessageId: m1 });
    check("non-recipient cannot mark read -> 404 (same as unknown, no probing)", readByOutsider.status === 404, readByOutsider);
    check("outsider attempt changed nothing", (await statusRow(m1)).state === "delivered");
    const read1 = await post("/status/read", bWeb.token, { senderDeviceId: a.deviceId, clientMessageId: m1 });
    check("any recipient device may report read (web)", read1.status === 200 && read1.json?.changed === true && read1.json?.state === "read", read1.json);
    const rd = await syncOne(m1);
    check("sender sees read + read_at, delivered_at kept", rd?.state === "read" && !!rd?.readAt && !!rd?.deliveredAt, rd);
    const read1b = await post("/status/read", bPhone.token, { senderDeviceId: a.deviceId, clientMessageId: m1 });
    check("repeat read is idempotent (changed:false)", read1b.status === 200 && read1b.json?.changed === false && read1b.json?.state === "read", read1b.json);
    check("read for an unknown message -> 404", (await post("/status/read", bPhone.token, { senderDeviceId: a.deviceId, clientMessageId: randomUUID() })).status === 404);

    console.log("\n[6] Ordering: read before delivery ack, then late ack must not downgrade");
    const m2 = randomUUID();
    await sendTo(m2);
    const readEarly = await post("/status/read", bPhone.token, { senderDeviceId: a.deviceId, clientMessageId: m2 });
    const e2 = await statusRow(m2);
    check("read straight from sent works", readEarly.json?.changed === true && e2.state === "read");
    check("read implies delivered: delivered_at is populated", !!e2.delivered_at && !!e2.read_at, e2);
    const rows2 = await pendingFor(m2);
    await ackOn(bPhone, rows2.find((r) => r.recipient_device_id === bPhone.deviceId)!.id);
    check("late delivery ack does NOT downgrade read -> delivered", (await statusRow(m2)).state === "read");

    console.log("\n[7] FAILED: sender-reported failure, and recovery");
    const m3 = randomUUID();
    await sendTo(m3);
    const f3 = await post("/status/failed", a.token, { clientMessageId: m3, reason: "RETRIES_EXHAUSTED" });
    check("sent -> failed", f3.status === 200 && f3.json?.changed === true && f3.json?.status?.state === "failed", f3.json);
    const fr3 = await statusRow(m3);
    check("failure recorded with reason and failed_at", fr3.state === "failed" && fr3.failure_reason === "RETRIES_EXHAUSTED" && !!fr3.failed_at, fr3);
    check("repeat failed report is idempotent", (await post("/status/failed", a.token, { clientMessageId: m3 })).json?.changed === false);
    check("failed for a message the server never saw -> 404 (red clock is local-only)", (await post("/status/failed", a.token, { clientMessageId: randomUUID() })).status === 404);
    check("cannot fail a delivered/read message -> 409", (await post("/status/failed", a.token, { clientMessageId: m1 })).status === 409);
    check("another user cannot fail Alice's message (scoped to sender device)", (await post("/status/failed", c.token, { clientMessageId: m3 })).status === 404);

    const beforeRetry = (await pendingFor(m3)).length;
    const retry = await sendTo(m3);
    check("retry of a failed message: duplicate:true, status back to sent", retry.json?.duplicate === true && retry.json?.status?.state === "sent", retry.json);
    check("retry inserted no extra queue rows", (await pendingFor(m3)).length === beforeRetry);
    check("failure fields cleared after retry", ((r) => r.state === "sent" && !r.failed_at && !r.failure_reason)(await statusRow(m3)));

    await post("/status/failed", a.token, { clientMessageId: m3 });
    const rows3 = await pendingFor(m3);
    await ackOn(bPhone, rows3.find((r) => r.recipient_device_id === bPhone.deviceId)!.id);
    const late = await statusRow(m3);
    check("if a 'failed' message actually arrives, delivery wins and failure is cleared", late.state === "delivered" && !late.failed_at && !late.failure_reason, late);

    console.log("\n[8] Idempotency survives the queue purge");
    const m4 = randomUUID();
    await sendTo(m4);
    for (const r of await pendingFor(m4)) await ackOn(r.recipient_device_id === bPhone.deviceId ? bPhone : bWeb, r.id);
    await pool.query(`SELECT public.cleanup_pending_messages()`).catch(() =>
      pool.query(`DELETE FROM pending_messages WHERE delivered_at IS NOT NULL OR expires_at < now()`),
    );
    check("queue rows for the delivered message are gone (structural deletion)", (await pendingFor(m4)).length === 0);
    check("...but sender status is still delivered", (await syncOne(m4))?.state === "delivered");
    const resend = await sendTo(m4);
    check("late retry of the same clientMessageId is a duplicate", resend.json?.duplicate === true && resend.json?.status?.state === "delivered", resend.json);
    check("...and did NOT re-queue the message (recipient never gets it twice)", (await pendingFor(m4)).length === 0);

    console.log("\n[9] Other paths");
    const legacy = await post("/send", a.token, { recipientDeviceId: bPhone.deviceId, ciphertext: "0102" });
    check("send without clientMessageId still works (legacy) and has no status row", legacy.status === 200 && !legacy.json?.status);
    const aliceHash = phoneHash(alice.phone);
    const carolHash = phoneHash(carol.phone);
    await pool.query(`INSERT INTO blocks (blocker_phone_hash, blocked_phone_hash) VALUES ($1, $2)`, [carolHash, aliceHash]);
    blockKeys.push([carolHash, aliceHash]);
    const mBlocked = randomUUID();
    const blocked = await post("/send", a.token, { clientMessageId: mBlocked, recipients: [{ deviceId: c.deviceId, ciphertext: "aa" }] });
    check("blocked send -> 403 and creates NO status row", blocked.status === 403 && !(await statusRow(mBlocked)));
    const bad = await post("/send", a.token, { clientMessageId: randomUUID(), recipients: [{ deviceId: randomUUID(), ciphertext: "aa" }] });
    check("rejected send (unknown device) leaves no status row", bad.status === 404);
    check("Bob cannot sync Alice's messages (scoped to sender device)", ((await post("/status/sync", bPhone.token, { clientMessageIds: [m1, m2, m3] })).json?.statuses ?? []).length === 0);
    const bySince = await post("/status/sync", a.token, { since: new Date(Date.now() - 60_000).toISOString() });
    check("sync by 'since' returns this device's recent statuses + serverTime", bySince.json?.statuses?.length >= 4 && typeof bySince.json?.serverTime === "string", bySince.json?.statuses?.length);
    const none = await post("/status/sync", a.token, { since: bySince.json?.serverTime });
    check("sync since serverTime returns nothing new", none.json?.statuses?.length === 0, none.json);

    console.log("\n[10] Retention");
    await pool.query(`UPDATE message_status SET expires_at = now() - interval '1 minute' WHERE sender_device_id=$1 AND client_message_id=$2`, [a.deviceId, m4]);
    check("expired status is hidden from sync even before cleanup runs", (await syncOne(m4)) === undefined);
    await pool.query(`SELECT public.cleanup_message_status()`);
    check("cleanup_message_status() hard-deletes expired rows", !(await statusRow(m4)));

    console.log("\n[11] Real-time push to the sender");
    const ioClient = await loadSocketClient();
    if (!ioClient) {
      skipped += 3;
      console.log("  SKIP  socket.io-client not resolvable - real-time push not verified here");
    } else {
      await pool.query(
        `INSERT INTO sessions (id, user_id, device_id, token_lookup, refresh_token_hash, refresh_token_expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
        [a.sessionId, alice.userId, a.deviceId, randomUUID().replace(/-/g, ""), "x".repeat(60)],
      );
      sessionIds.push(a.sessionId);
      const events: Array<{ clientMessageId: string; state: string }> = [];
      const sock = ioClient.io(`http://127.0.0.1:${port}`, {
        path: SOCKET_NAMESPACE,
        auth: { token: a.token, userId: alice.userId, deviceId: a.deviceId },
        transports: ["websocket"],
      });
      sockets.push(sock);
      await new Promise<void>((res, rej) => {
        sock.on("connect", () => res());
        sock.on("connect_error", (e: never) => rej(e));
      });
      sock.on("message_status", ((ev: { clientMessageId: string; state: string }) => events.push(ev)) as (...a: never[]) => void);

      const m5 = randomUUID();
      await sendTo(m5);
      const rows5 = await pendingFor(m5);
      const ackA = await ackOn(bPhone, rows5.find((r) => r.recipient_device_id === bPhone.deviceId)!.id);
      await sleep(400);
      check("ack pushes {state: delivered} to the sender's live socket", ackA.status === 200 && events.some((e) => e.clientMessageId === m5 && e.state === "delivered"), events);
      await ackOn(bWeb, rows5.find((r) => r.recipient_device_id === bWeb.deviceId)!.id);
      await sleep(300);
      check("sibling device ack pushes nothing extra", events.filter((e) => e.clientMessageId === m5).length === 1, events);
      const rd5 = await post("/status/read", bPhone.token, { senderDeviceId: a.deviceId, clientMessageId: m5 });
      await sleep(400);
      check("read pushes {state: read} to the sender's live socket", rd5.json?.senderPushed === true && events.some((e) => e.clientMessageId === m5 && e.state === "read"), { rd5: rd5.json, events });
      sock.close();
      await sleep(300);

      const m6 = randomUUID();
      await sendTo(m6);
      const rows6 = await pendingFor(m6);
      await ackOn(bPhone, rows6.find((r) => r.recipient_device_id === bPhone.deviceId)!.id);
      const rd6 = await post("/status/read", bPhone.token, { senderDeviceId: a.deviceId, clientMessageId: m6 });
      check("sender offline: read still succeeds, senderPushed=false", rd6.status === 200 && rd6.json?.senderPushed === false, rd6.json);
      check("...and the sender catches up via /status/sync on reconnect", (await syncOne(m6))?.state === "read");
    }
  } finally {
    for (const s of sockets) s.close();
    if (sessionIds.length) await pool.query(`DELETE FROM sessions WHERE id = ANY($1::uuid[])`, [sessionIds]);
    for (const [x, y] of blockKeys) await pool.query(`DELETE FROM blocks WHERE blocker_phone_hash = $1 AND blocked_phone_hash = $2`, [x, y]);
    if (deviceIds.length) {
      await pool.query(`DELETE FROM message_status WHERE sender_device_id = ANY($1::uuid[])`, [deviceIds]);
      await pool.query(`DELETE FROM pending_messages WHERE sender_device_id = ANY($1::uuid[]) OR recipient_device_id = ANY($1::uuid[])`, [deviceIds]);
      await pool.query(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [deviceIds]);
    }
    if (userIds.length) await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
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
