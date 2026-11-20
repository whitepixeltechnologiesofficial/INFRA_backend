/**
 * BE-5.7 verification: group message fan-out with per-recipient status and the 70-member cap.
 *
 * Starts the real Express + socket.io app on a random port, creates throwaway users/devices/groups
 * and drives the real /relay routes and real sockets:
 *   [1] validation and authorization (non-member, admins_only, empty group)
 *   [2] fan-out: one ciphertext queued per recipient DEVICE, none for the sender, members with no
 *       device skipped; online members are live-pushed, offline ones are not
 *   [3] offline members receive it on reconnect (BE-5.6 drain) and via /relay/poll
 *   [4] per-recipient status: each member's ack / read moves only their own row; the live sender is
 *       told per recipient; an outsider cannot report read
 *   [5] retry with the same clientMessageId is idempotent (no extra rows, no re-push)
 *   [6] blocking does not apply inside a shared group (PRD 19.8) while 1:1 blocking still does
 *   [7] a member removed after the send never receives the queued copy
 *   [8] the 70-member cap: a 70-member group fans out to 69 recipients, the 71st member is refused
 *
 * Requires migrations 018, 019 and 023, and socket.io-client resolvable from apps/backend.
 * Run: pnpm --filter @wpt/backend exec tsx src/db/group-fanout-e2e-test.ts
 */

import "dotenv/config";
import { randomUUID, randomInt } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createPool } from "./pool.js";
import { createApp } from "../app.js";
import { issueAccessToken } from "../auth/jwt.js";
import { phoneHash } from "../utils/phone-hash.js";
import { getConnectionCount } from "../ws/socket-registry.js";
import { GROUP_MEMBER_CAP } from "../routes/relay-group.js";

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
type Msg = { id: string; senderDeviceId: string; groupId: string | null; ciphertext: string; clientMessageId: string | null };
type StatusEv = { clientMessageId: string; recipientUserId: string; state: string; deliveredAt: string | null };

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const pool = createPool({ connectionString: dbUrl });

  const needed = await pool.query(
    `SELECT
       (SELECT count(*) FROM pg_constraint WHERE conname = 'message_status_sender_msg_recipient_uniq')::int AS uniq,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'group_members_enforce_cap')::int AS cap,
       (SELECT count(*) FROM information_schema.columns WHERE table_name = 'pending_messages' AND column_name = 'client_message_id')::int AS m018`,
  );
  if (needed.rows[0].uniq !== 1 || needed.rows[0].cap !== 1 || needed.rows[0].m018 !== 1) {
    await pool.end();
    throw new Error("Migrations 018, 019 and 023 must all be applied first (023 is the BE-5.7 migration).");
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
  const groupIds: string[] = [];
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

    type Role = "owner" | "admin" | "member";
    const makeGroup = async (members: Array<{ userId: string; role: Role }>, whoCanSend: "everyone" | "admins_only" = "everyone") => {
      const id = randomUUID();
      await pool.query(`INSERT INTO groups (id, encrypted_name, who_can_send) VALUES ($1, decode('6e616d65', 'hex'), $2)`, [id, whoCanSend]);
      groupIds.push(id);
      for (const m of members) {
        await pool.query(`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)`, [id, m.userId, m.role]);
      }
      return id;
    };

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
    const goOffline = async (c: { sock: MiniSocket }, userId: string) => {
      c.sock.close();
      await waitFor(() => getConnectionCount(userId) === 0);
    };

    const hex = (s: string) => Buffer.from(s).toString("hex");
    const sendGroup = (token: string, groupId: string | undefined, clientMessageId: string | undefined, ct: string) =>
      api("/send", token, { clientMessageId, recipientGroupId: groupId, ciphertext: hex(ct) });

    const alice = await makeUser(["phone"]);
    const bob = await makeUser(["phone", "web"]);
    const carol = await makeUser(["phone"]);
    const dave = await makeUser(["phone"]);
    const erin = await makeUser([]); // member with NO device: must be skipped, not fail the send
    const frank = await makeUser(["phone"]); // never a member of G1
    const [a] = alice.devs;
    const [bPhone, bWeb] = bob.devs;
    const [c] = carol.devs;
    const [d] = dave.devs;
    const [f] = frank.devs;

    const g1 = await makeGroup([
      { userId: alice.userId, role: "owner" },
      { userId: bob.userId, role: "member" },
      { userId: carol.userId, role: "member" },
      { userId: dave.userId, role: "member" },
      { userId: erin.userId, role: "member" },
    ]);
    const statusMap = async (clientMessageId: string) => {
      const r = await api("/status/sync", a!.token, { clientMessageIds: [clientMessageId] });
      const m = new Map<string, StatusEv>();
      for (const s of (r.json?.statuses ?? []) as StatusEv[]) m.set(s.recipientUserId, s);
      return m;
    };
    const queuedRows = async (clientMessageId: string) =>
      (await pool.query(
        `SELECT recipient_device_id, recipient_user_id, recipient_group_id, encode(ciphertext, 'hex') AS ct, delivered_at
           FROM pending_messages WHERE client_message_id = $1`,
        [clientMessageId],
      )).rows as Array<{ recipient_device_id: string; recipient_user_id: string | null; recipient_group_id: string | null; ct: string; delivered_at: string | null }>;

    // Alice stays online so she can receive live per-recipient status pushes.
    const aliceConn = await connect(a!, alice.userId);

    console.log("\n[1] Validation and authorization");
    check("group send without clientMessageId -> 400", (await sendGroup(a!.token, g1, undefined, "x")).status === 400);
    check("malformed group id -> 400", (await sendGroup(a!.token, "not-a-uuid", randomUUID(), "x")).status === 400);
    check(
      "non-hex ciphertext -> 400",
      (await api("/send", a!.token, { clientMessageId: randomUUID(), recipientGroupId: g1, ciphertext: "zz" })).status === 400,
    );
    check("unknown group -> 404", (await sendGroup(a!.token, randomUUID(), randomUUID(), "x")).status === 404);
    check("sender who is NOT a member -> 404 (same as unknown, no probing)", (await sendGroup(f!.token, g1, randomUUID(), "x")).status === 404);
    const gSolo = await makeGroup([{ userId: alice.userId, role: "owner" }]);
    check("group with no other members -> 400", (await sendGroup(a!.token, gSolo, randomUUID(), "x")).status === 400);
    const gAdmins = await makeGroup(
      [
        { userId: bob.userId, role: "owner" },
        { userId: alice.userId, role: "member" },
      ],
      "admins_only",
    );
    const adminsDenied = await sendGroup(a!.token, gAdmins, randomUUID(), "x");
    check("admins_only: plain member -> 403 ADMINS_ONLY", adminsDenied.status === 403 && adminsDenied.json?.error === "ADMINS_ONLY", adminsDenied.json);
    await pool.query(`UPDATE group_members SET role = 'admin' WHERE group_id = $1 AND user_id = $2`, [gAdmins, alice.userId]);
    check("admins_only: after promotion to admin -> 200", (await sendGroup(a!.token, gAdmins, randomUUID(), "x")).status === 200);

    console.log("\n[2] Fan-out: one ciphertext per recipient device, per-recipient status rows");
    const carolConn = await connect(c!, carol.userId); // online; Bob and Dave are offline
    const msg1 = randomUUID();
    const s1 = await sendGroup(a!.token, g1, msg1, "group-hello");
    check("send -> 200, not duplicate", s1.status === 200 && s1.json?.duplicate === false, s1.json);
    check("recipientCount 3 (Bob, Carol, Dave), Erin (no device) skipped", s1.json?.recipientCount === 3 && s1.json?.skippedMembers === 1, s1.json);
    check("4 queue rows (Bob x2 devices, Carol, Dave)", s1.json?.count === 4, s1.json?.count);
    const q1 = await queuedRows(msg1);
    const expectedDevices = [bPhone!.deviceId, bWeb!.deviceId, c!.deviceId, d!.deviceId].sort();
    check(
      "rows are addressed to exactly those 4 devices, none to the sender",
      JSON.stringify(q1.map((r) => r.recipient_device_id).sort()) === JSON.stringify(expectedDevices),
    );
    check("every row is a group row: group id set, user id NULL", q1.every((r) => r.recipient_group_id === g1 && r.recipient_user_id === null));
    check("same opaque ciphertext on every row (encrypted once)", q1.every((r) => r.ct === hex("group-hello")));
    const pushedByDevice = new Map<string, boolean>((s1.json?.rows ?? []).map((r: { recipientDeviceId: string; pushed: boolean }) => [r.recipientDeviceId, r.pushed]));
    check(
      "only the online member's device was live-pushed",
      pushedByDevice.get(c!.deviceId) === true && pushedByDevice.get(bPhone!.deviceId) === false && pushedByDevice.get(d!.deviceId) === false,
      [...pushedByDevice],
    );
    await waitFor(() => carolConn.messages.length >= 1);
    check(
      "Carol's socket got the message with groupId and ciphertext",
      carolConn.messages.length === 1 && carolConn.messages[0]!.groupId === g1 && carolConn.messages[0]!.ciphertext === hex("group-hello"),
      carolConn.messages,
    );
    const st1 = await statusMap(msg1);
    check(
      "3 status rows, all `sent`, one per recipient member",
      st1.size === 3 && [bob.userId, carol.userId, dave.userId].every((u) => st1.get(u)?.state === "sent"),
      [...st1.keys()],
    );
    check("no status row for the sender or the device-less member", !st1.has(alice.userId) && !st1.has(erin.userId));

    console.log("\n[3] Offline members get it on reconnect and via poll");
    const daveConn = await connect(d!, dave.userId);
    await waitFor(() => daveConn.messages.length >= 1);
    check("Dave (was offline) receives it on connect, with groupId", daveConn.messages.length === 1 && daveConn.messages[0]!.groupId === g1, daveConn.messages);
    // Bob is also the owner of the admins_only group from [1], so he legitimately has that
    // group's message queued too. Pick out THIS message by clientMessageId.
    const bobConn = await connect(bPhone!, bob.userId);
    await waitFor(() => bobConn.messages.some((x) => x.clientMessageId === msg1));
    const bobMsg1 = bobConn.messages.filter((x) => x.clientMessageId === msg1);
    check(
      "Bob's phone receives it on connect, once, with groupId",
      bobMsg1.length === 1 && bobMsg1[0]!.groupId === g1 && bobMsg1[0]!.ciphertext === hex("group-hello"),
      bobConn.messages,
    );
    const webPoll = await api("/poll", bWeb!.token);
    const webMsg1 = ((webPoll.json?.messages ?? []) as Msg[]).filter((x) => x.clientMessageId === msg1);
    check(
      "Bob's web device gets its own copy via /relay/poll (group rows are pollable)",
      webMsg1.length === 1 && webMsg1[0]!.groupId === g1 && webMsg1[0]!.ciphertext === hex("group-hello"),
      webPoll.json,
    );
    const frankPoll = await api("/poll", f!.token);
    check("a non-member's poll sees nothing", (frankPoll.json?.messages ?? []).length === 0);

    console.log("\n[4] Per-recipient status");
    const ev = (clientMessageId: string) => aliceConn.statuses.filter((s) => s.clientMessageId === clientMessageId);
    const ackCarol = await api("/ack", c!.token, { messageId: carolConn.messages[0]!.id });
    check("Carol acks -> 200", ackCarol.status === 200 && ackCarol.json?.success === true, ackCarol.json);
    let m = await statusMap(msg1);
    check(
      "only Carol is `delivered`; Bob and Dave are still `sent`",
      m.get(carol.userId)?.state === "delivered" && m.get(bob.userId)?.state === "sent" && m.get(dave.userId)?.state === "sent",
      [...m].map(([k, v]) => [k, v.state]),
    );
    await waitFor(() => ev(msg1).length >= 1);
    check(
      "Alice's live socket got exactly one push, for Carol",
      ev(msg1).length === 1 && ev(msg1)[0]!.recipientUserId === carol.userId && ev(msg1)[0]!.state === "delivered",
      ev(msg1),
    );
    await api("/ack", bPhone!.token, { messageId: bobMsg1[0]!.id });
    await api("/ack", bWeb!.token, { messageId: webMsg1[0]!.id });
    m = await statusMap(msg1);
    check("Bob `delivered` once any of his devices acks", m.get(bob.userId)?.state === "delivered");
    await sleep(300);
    check("Bob's second device ack pushed nothing extra (Carol + Bob = 2 events)", ev(msg1).length === 2, ev(msg1));
    const outsiderRead = await api("/status/read", f!.token, { senderDeviceId: a!.deviceId, clientMessageId: msg1 });
    check("an outsider cannot report read -> 404", outsiderRead.status === 404);
    const daveRead = await api("/status/read", d!.token, { senderDeviceId: a!.deviceId, clientMessageId: msg1 });
    check("Dave reports read -> `read`", daveRead.status === 200 && daveRead.json?.state === "read", daveRead.json);
    m = await statusMap(msg1);
    check(
      "final: Carol delivered, Bob delivered, Dave read (delivered_at kept)",
      m.get(carol.userId)?.state === "delivered" &&
        m.get(bob.userId)?.state === "delivered" &&
        m.get(dave.userId)?.state === "read" &&
        m.get(dave.userId)?.deliveredAt != null,
      [...m].map(([k, v]) => [k, v.state]),
    );

    console.log("\n[5] Idempotent retry");
    const carolBefore = carolConn.messages.length;
    const retry = await sendGroup(a!.token, g1, msg1, "group-hello");
    check("retry -> 200 duplicate:true, 3 statuses unchanged", retry.status === 200 && retry.json?.duplicate === true && retry.json?.statuses?.length === 3, retry.json);
    check("statuses were not reset", retry.json?.statuses?.some((s: StatusEv) => s.recipientUserId === dave.userId && s.state === "read"));
    check("still exactly 4 queue rows", (await queuedRows(msg1)).length === 4);
    await sleep(300);
    check("nothing re-pushed to Carol", carolConn.messages.length === carolBefore);

    // Two retries of a NEW clientMessageId fired at once: the unique indexes reject the loser, which
    // must be answered as a duplicate (200) rather than an error, and nothing may be queued twice.
    const msgRace = randomUUID();
    const race = await Promise.all([
      sendGroup(a!.token, g1, msgRace, "race"),
      sendGroup(a!.token, g1, msgRace, "race"),
      sendGroup(a!.token, g1, msgRace, "race"),
    ]);
    check("concurrent retries all answer 200", race.every((r) => r.status === 200), race.map((r) => r.status));
    check("exactly one of them did the send, the rest are duplicates", race.filter((r) => r.json?.duplicate === false).length === 1, race.map((r) => r.json?.duplicate));
    check("queued exactly once: 4 rows, 3 status rows", (await queuedRows(msgRace)).length === 4 && (await statusMap(msgRace)).size === 3);

    console.log("\n[6] Blocking does not apply inside a shared group (PRD 19.8)");
    const ph = (p: string) => phoneHash(p);
    await pool.query(`INSERT INTO blocks (blocker_phone_hash, blocked_phone_hash) VALUES ($1, $2)`, [ph(dave.phone), ph(alice.phone)]);
    blockKeys.push([ph(dave.phone), ph(alice.phone)]);
    await goOffline(daveConn, dave.userId);
    const msg2 = randomUUID();
    const s2 = await sendGroup(a!.token, g1, msg2, "group-while-blocked");
    check("group send still succeeds with a block in place", s2.status === 200 && s2.json?.recipientCount === 3, s2.json);
    const daveConn2 = await connect(d!, dave.userId);
    await waitFor(() => daveConn2.messages.some((x) => x.clientMessageId === msg2));
    check("blocked-sender group message is delivered on reconnect", daveConn2.messages.some((x) => x.clientMessageId === msg2 && x.groupId === g1), daveConn2.messages);
    const davePoll = await api("/poll", d!.token);
    check("...and via poll", (davePoll.json?.messages ?? []).some((x: Msg) => x.clientMessageId === msg2));
    const oneToOne = await api("/send", a!.token, { clientMessageId: randomUUID(), recipients: [{ deviceId: d!.deviceId, ciphertext: hex("direct") }] });
    check("control: the same block still stops a 1:1 send -> 403", oneToOne.status === 403, oneToOne.json);
    await pool.query(`DELETE FROM blocks WHERE blocker_phone_hash = $1 AND blocked_phone_hash = $2`, [ph(dave.phone), ph(alice.phone)]);
    await goOffline(daveConn2, dave.userId);

    console.log("\n[7] A member removed after the send never receives the queued copy");
    await goOffline(carolConn, carol.userId);
    const msg3 = randomUUID();
    await sendGroup(a!.token, g1, msg3, "after-carol-leaves");
    await pool.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, [g1, carol.userId]);
    const carolConn2 = await connect(c!, carol.userId);
    await sleep(800);
    check("removed member gets nothing on reconnect (msg2 and msg3 were queued, both withheld)", carolConn2.messages.length === 0, carolConn2.messages);
    const carolPoll = await api("/poll", c!.token);
    check("...nor via poll", (carolPoll.json?.messages ?? []).length === 0, carolPoll.json);
    check("a removed member can no longer send to the group -> 404", (await sendGroup(c!.token, g1, randomUUID(), "x")).status === 404);
    const bobStill = await api("/poll", bPhone!.token);
    check("control: remaining member Bob still gets msg3 via poll", (bobStill.json?.messages ?? []).some((x: Msg) => x.clientMessageId === msg3));
    await goOffline(carolConn2, carol.userId);

    console.log(`\n[8] The ${GROUP_MEMBER_CAP}-member cap`);
    const capBase = randomInt(2000000000, 2800000000);
    const capUsers = (
      await pool.query(
        `INSERT INTO users (id, phone_number, name)
         SELECT gen_random_uuid(), '+1' || ($1::bigint + i)::text, 'Cap User ' || i
           FROM generate_series(1, $2::int) AS i
         RETURNING id`,
        [capBase, GROUP_MEMBER_CAP - 1],
      )
    ).rows.map((r: { id: string }) => r.id);
    userIds.push(...capUsers);
    const capDevices = (
      await pool.query(
        `INSERT INTO devices (id, user_id, device_type, platform, identity_public_key)
         SELECT gen_random_uuid(), u, 'phone', 'android', 'pf_cap_' || u::text FROM unnest($1::uuid[]) AS u
         RETURNING id`,
        [capUsers],
      )
    ).rows.map((r: { id: string }) => r.id);
    deviceIds.push(...capDevices);
    const g3 = randomUUID();
    await pool.query(`INSERT INTO groups (id, encrypted_name) VALUES ($1, decode('6e616d65', 'hex'))`, [g3]);
    groupIds.push(g3);
    await pool.query(`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')`, [g3, alice.userId]);
    await pool.query(`INSERT INTO group_members (group_id, user_id, role) SELECT $1, u, 'member' FROM unnest($2::uuid[]) AS u`, [g3, capUsers]);
    const memberCount = (await pool.query(`SELECT count(*)::int AS n FROM group_members WHERE group_id = $1`, [g3])).rows[0].n;
    check(`group built with exactly ${GROUP_MEMBER_CAP} members`, memberCount === GROUP_MEMBER_CAP, memberCount);
    const msg4 = randomUUID();
    const s4 = await sendGroup(a!.token, g3, msg4, "to-the-whole-group");
    check(
      `${GROUP_MEMBER_CAP}-member group: delivered to all ${GROUP_MEMBER_CAP - 1} other members`,
      s4.status === 200 && s4.json?.recipientCount === GROUP_MEMBER_CAP - 1 && s4.json?.count === GROUP_MEMBER_CAP - 1,
      s4.json && { status: s4.status, recipientCount: s4.json.recipientCount, count: s4.json.count, error: s4.json.error },
    );
    const st4 = await statusMap(msg4);
    check(`${GROUP_MEMBER_CAP - 1} per-recipient status rows, all \`sent\``, st4.size === GROUP_MEMBER_CAP - 1 && [...st4.values()].every((s) => s.state === "sent"), st4.size);
    let capErr: { code?: string; message?: string } | null = null;
    try {
      await pool.query(`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')`, [g3, frank.userId]);
    } catch (e) {
      capErr = e as { code?: string; message?: string };
    }
    check(
      "adding a 71st member is refused by the database (check_violation / GROUP_MEMBER_CAP)",
      capErr !== null && capErr.code === "23514" && /GROUP_MEMBER_CAP/.test(capErr.message ?? ""),
      capErr,
    );
    const after71 = (await pool.query(`SELECT count(*)::int AS n FROM group_members WHERE group_id = $1`, [g3])).rows[0].n;
    check("membership is still exactly 70 after the refused insert", after71 === GROUP_MEMBER_CAP, after71);
  } finally {
    for (const s of openSockets) s.close();
    if (groupIds.length) await pool.query(`DELETE FROM groups WHERE id = ANY($1::uuid[])`, [groupIds]);
    if (sessionIds.length) await pool.query(`DELETE FROM sessions WHERE id = ANY($1::uuid[])`, [sessionIds]);
    for (const [x, y] of blockKeys) await pool.query(`DELETE FROM blocks WHERE blocker_phone_hash = $1 AND blocked_phone_hash = $2`, [x, y]);
    if (deviceIds.length) {
      await pool.query(`DELETE FROM pending_messages WHERE sender_device_id = ANY($1::uuid[]) OR recipient_device_id = ANY($1::uuid[])`, [deviceIds]);
      await pool.query(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [deviceIds]);
    }
    if (userIds.length) await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
    const after = await pool.query(`SELECT count(*)::int AS n FROM pending_messages`);
    const leftoverStatus = await pool.query(`SELECT count(*)::int AS n FROM message_status WHERE sender_user_id = ANY($1::uuid[])`, [userIds]);
    console.log(`\npending_messages rows before/after: ${before.rows[0].n}/${after.rows[0].n}`);
    console.log(`message_status rows left from this run: ${leftoverStatus.rows[0].n}`);
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
