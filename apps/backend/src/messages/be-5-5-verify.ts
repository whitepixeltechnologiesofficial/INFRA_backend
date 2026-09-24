/**
 * BE-5.5 — Read receipts + typing indicators backend verification harness.
 *
 * Proves, with only Node + tsx (no Postgres, no real sockets):
 *
 *   A) Pure core parity with the WPT web-server semantics + the canonical
 *      shared contract (packages/shared/realtime.ts), including every
 *      rejection code and the server-side typing TTL auto-clear.
 *   B) Wire-body parity with the UNCHANGED Web client helpers: the exact
 *      objects `buildReadRequest` produces are what the Express routes accept.
 *   C) Autonomous HTTP over the real mounted router (`/api/messages/read`,
 *      `/api/messages/typing`) with JWT auth and a fake socket.io recorder,
 *      proving the endpoints work end-to-end without a device.
 *
 * Run: pnpm --filter @wpt/backend exec tsx src/messages/be-5-5-verify.ts
 */
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { READ_ROUTE, TYPING_ROUTE, TYPING_TTL_MS } from "@wpt/shared";
import {
  applyRead,
  createTypingController,
  resolveReadThrough,
  type RealtimeDeps,
  type ReadResult,
} from "./realtime.js";
import { bindIo, overrideProviders, resetProviders } from "./providers.js";

interface ReceiptHelpers {
  buildReadRequest: (p: { from: string; isGroup: boolean; to?: string | null; groupId?: string | null; messageId: string }) => Record<string, unknown>;
  nextMessageStatus: (current: string | null | undefined, event: "echo" | "rejected" | "read") => string;
  applyReadReceipt: (list: { id: string; from: string; status?: string }[], ids: string[], meId: string) => number;
}

// Loaded at runtime only (non-static specifier so the backend tsconfig's
// rootDir/src never sees the @wpt/web file; tsx resolves the relative .ts).
async function loadReceipts(): Promise<ReceiptHelpers> {
  const rel = ["..", "..", "..", "web", "app", "lib", "receipts.ts"].join("/");
  const mod = (await import(rel)) as Partial<ReceiptHelpers>;
  if (!mod.buildReadRequest || !mod.nextMessageStatus || !mod.applyReadReceipt) {
    throw new Error("receipts.ts did not expose the expected helpers");
  }
  return mod as ReceiptHelpers;
}

function isReadResult(v: unknown): v is ReadResult {
  return Boolean(v) && typeof v === "object" && "ok" in (v as Record<string, unknown>);
}

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function noBroadcast(): (rooms: readonly string[], payload: unknown) => void {
  return () => {};
}

function buildCoreDeps(over: Partial<RealtimeDeps>): RealtimeDeps {
  return {
    userExists: () => true,
    groupMembers: () => null,
    directThread: () => [],
    groupThread: () => [],
    broadcast: noBroadcast(),
    now: () => "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A) Pure core: read receipts
// ─────────────────────────────────────────────────────────────────────────────
async function coreReadTests(): Promise<void> {
  const thread = [
    { id: "m1", from: "b" },
    { id: "m2", from: "a" },
    { id: "m3", from: "b" },
    { id: "m4", from: "b" },
  ];

  const broadcasts: { rooms: string[]; payload: unknown }[] = [];
  const deps = buildCoreDeps({
    userExists: (id) => id === "a" || id === "b",
    directThread: () => thread,
    broadcast: (rooms, payload) => broadcasts.push({ rooms: [...rooms], payload }),
  });

  const res = applyRead(deps, { target: { kind: "direct", from: "a", to: "b" }, messageId: "m4" });
  check("direct read-through resolves peer rows to messageId", isReadResult(res) && res.ok && res.read === 3);
  if (isReadResult(res) && res.ok) {
    const p = res.payload;
    check("direct broadcast wire: type/from/to/messageId", p.type === "read" && p.from === "a" && p.to === "b" && p.messageId === "m4");
    check("direct messageIds = peer-authored rows up to m4", JSON.stringify(p.messageIds) === JSON.stringify(["m1", "m3", "m4"]));
    check("direct broadcast rooms dm:+user:from+user:to", JSON.stringify(res.rooms) === JSON.stringify(["dm:a:b", "user:a", "user:b"]));
    check("direct broadcast delivered once via deps", broadcasts.length === 1 && broadcasts[0]?.payload === p);
  }

  const idx = resolveReadThrough(thread, "a", "m4", true, "b");
  check("resolveReadThrough direct returns index of m4", idx.index === 3);
  const idxOwn = resolveReadThrough(thread, "a", "m2", true, "b");
  check("direct resolveReadThrough with own mid reports only peer rows, stops at mid", idxOwn.index === 1 && JSON.stringify(idxOwn.ids) === JSON.stringify(["m1"]));

  const directNotFound = applyRead(buildCoreDeps({ directThread: () => thread }), {
    target: { kind: "direct", from: "a", to: "b" },
    messageId: "nope",
  });
  check("direct unknown messageId -> 404 read_not_found", isReadResult(directNotFound) && !directNotFound.ok && directNotFound.status === 404 && directNotFound.error === "read_not_found");

  const badReader = applyRead(buildCoreDeps({ userExists: (id) => id === "b" }), {
    target: { kind: "direct", from: "a", to: "b" },
    messageId: "m1",
  });
  check("unknown reporter -> 400 bad_read", isReadResult(badReader) && !badReader.ok && badReader.status === 400 && badReader.error === "bad_read");

  const unknownPeer = applyRead(buildCoreDeps({ userExists: (id) => id === "a" }), {
    target: { kind: "direct", from: "a", to: "b" },
    messageId: "m1",
  });
  check("unknown direct peer -> 404 user_not_found", isReadResult(unknownPeer) && !unknownPeer.ok && unknownPeer.status === 404 && unknownPeer.error === "user_not_found");

  const gThread = [
    { id: "g1m1", from: "u1" },
    { id: "g1m2", from: "u2" },
    { id: "g1m3", from: "u1" },
    { id: "g1m4", from: "u3" },
  ];
  const gBroadcasts: { rooms: string[]; payload: unknown }[] = [];
  const gDeps = buildCoreDeps({
    userExists: (id) => ["u1", "u2", "u3"].includes(id),
    groupMembers: () => ["u1", "u2", "u3"],
    groupThread: () => gThread,
    broadcast: (rooms, payload) => gBroadcasts.push({ rooms: [...rooms], payload }),
  });
  const gRes = applyRead(gDeps, { target: { kind: "group", from: "u2", groupId: "g1" }, messageId: "g1m3" });
  check("group read-through resolves other-members' rows to messageId", isReadResult(gRes) && gRes.ok && gRes.read === 2);
  if (isReadResult(gRes) && gRes.ok) {
    check("group broadcast wire: type/from/groupId/messageId", gRes.payload.type === "read" && gRes.payload.from === "u2" && gRes.payload.groupId === "g1" && gRes.payload.messageId === "g1m3");
    check("group messageIds = non-reporter rows up to g1m3", JSON.stringify(gRes.payload.messageIds) === JSON.stringify(["g1m1", "g1m3"]));
    check("group broadcast rooms = group:+each member user:", JSON.stringify(gRes.rooms) === JSON.stringify(["group:g1", "user:u1", "user:u2", "user:u3"]));
  }

  const nonMember = applyRead(buildCoreDeps({ groupMembers: () => ["u1", "u2"] }), {
    target: { kind: "group", from: "u3", groupId: "g1" },
    messageId: "g1m1",
  });
  check("non-member group read -> 403 not_member", isReadResult(nonMember) && !nonMember.ok && nonMember.status === 403 && nonMember.error === "not_member");

  const noGroup = applyRead(buildCoreDeps({ groupMembers: () => null }), {
    target: { kind: "group", from: "u1", groupId: "gX" },
    messageId: "g1m1",
  });
  check("unknown group read -> 403 not_member", isReadResult(noGroup) && !noGroup.ok && noGroup.status === 403 && noGroup.error === "not_member");

  const gNotFound = applyRead(buildCoreDeps({ groupMembers: () => ["u1"], groupThread: () => gThread }), {
    target: { kind: "group", from: "u1", groupId: "g1" },
    messageId: "missing",
  });
  check("group unknown messageId -> 404 read_not_found", isReadResult(gNotFound) && !gNotFound.ok && gNotFound.status === 404 && gNotFound.error === "read_not_found");
}

// ─────────────────────────────────────────────────────────────────────────────
// A) Pure core: typing with TTL
// ─────────────────────────────────────────────────────────────────────────────
function coreTypingTests(): void {
  const fired: unknown[] = [];
  const controller = createTypingController({
    broadcast: (rooms, payload) => fired.push({ rooms: [...rooms], payload }),
    now: () => "2026-01-01T00:00:00.000Z",
  }, 30);

  const on = controller.typing({ target: { kind: "direct", from: "a", to: "b" }, typing: true }, { fromOk: true, toOk: true });
  check("direct typing:on -> ok", on.ok && on.typing === true);
  const onFirst = on.ok ? on.payloads[0] : undefined;
  if (onFirst) {
    const p = onFirst.payload as { type: string; from: string; kind: string; to: string; typing: boolean; at: string };
    check("direct typing:on wire shape", p.type === "typing" && p.from === "a" && p.kind === "direct" && p.to === "b" && p.typing === true && typeof p.at === "string");
    check("direct typing:on rooms", JSON.stringify(onFirst.rooms) === JSON.stringify(["dm:a:b", "user:a", "user:b"]));
  }

  const off = controller.typing({ target: { kind: "direct", from: "a", to: "b" }, typing: false }, { fromOk: true, toOk: true });
  check("direct typing:off with active timer -> clears", off.ok && off.typing === false && off.payloads.length === 1);
  const offFirst = off.ok ? off.payloads[0] : undefined;
  if (offFirst) {
    check("direct typing:off broadcast typing:false", (offFirst.payload as { typing: boolean }).typing === false);
  }

  const offSansTimer = controller.typing({ target: { kind: "direct", from: "c", to: "b" }, typing: false }, { fromOk: true, toOk: true });
  check("direct typing:off with no active timer -> no broadcast", offSansTimer.ok && offSansTimer.typing === false && offSansTimer.payloads.length === 0);

  const gOn = controller.typing({ target: { kind: "group", from: "u1", groupId: "g1" }, typing: true }, { fromOk: true, members: ["u1", "u2"] });
  check("group typing:on -> ok + kind group", gOn.ok && gOn.payloads[0]?.payload.kind === "group" && gOn.payloads[0]?.payload.groupId === "g1");

  const badTypist = controller.typing({ target: { kind: "direct", from: "a", to: "b" }, typing: true }, { fromOk: false });
  check("unknown typist -> 400 bad_typing", !badTypist.ok && badTypist.status === 400 && badTypist.error === "bad_typing");

  const noTo = controller.typing({ target: { kind: "direct", from: "a", to: "x" }, typing: true }, { fromOk: true, toOk: false });
  check("unknown direct peer -> 404 user_not_found", !noTo.ok && noTo.status === 404 && noTo.error === "user_not_found");

  const notMember = controller.typing({ target: { kind: "group", from: "u3", groupId: "g1" }, typing: true }, { fromOk: true, members: ["u1", "u2"] });
  check("non-member group typing -> 403 not_member", !notMember.ok && notMember.status === 403 && notMember.error === "not_member");

  controller.dispose();
}

// ─────────────────────────────────────────────────────────────────────────────
// A) Pure core: typing TTL auto-clear
// ─────────────────────────────────────────────────────────────────────────────
async function coreTtlTest(): Promise<void> {
  const fired: unknown[] = [];
  const controller = createTypingController({
    broadcast: (_rooms, payload) => fired.push(payload),
  }, 25);

  const on = controller.typing({ target: { kind: "direct", from: "a", to: "b" }, typing: true }, { fromOk: true, toOk: true });
  check("TTL: typing:on accepted", on.ok && fired.length === 1);

  await new Promise((r) => setTimeout(r, 70));

  const auto = fired[fired.length - 1] as { type: string; typing: boolean; from: string; to: string };
  check("TTL: quiet typist auto-cleared with typing:false", fired.length === 2 && auto.type === "typing" && auto.typing === false && auto.from === "a" && auto.to === "b");
  controller.dispose();
}

// ─────────────────────────────────────────────────────────────────────────────
// B) Wire-body parity with the unchanged Web client helpers
// ─────────────────────────────────────────────────────────────────────────────
function clientParityTests(rc: ReceiptHelpers): void {
  const direct = rc.buildReadRequest({ from: "u1", isGroup: false, to: "u2", messageId: "m4" });
  check("buildReadRequest direct body == route shape", JSON.stringify(direct) === JSON.stringify({ from: "u1", type: "direct", to: "u2", messageId: "m4" }));

  const group = rc.buildReadRequest({ from: "u1", isGroup: true, groupId: "g1", messageId: "m4" });
  check("buildReadRequest group body == route shape", JSON.stringify(group) === JSON.stringify({ from: "u1", type: "group", groupId: "g1", messageId: "m4" }));

  check("shared READ_ROUTE constant", READ_ROUTE === "/api/messages/read");
  check("shared TYPING_ROUTE constant", TYPING_ROUTE === "/api/messages/typing");
  check("shared TYPING_TTL_MS is positive", TYPING_TTL_MS > 0);

  check("nextMessageStatus: echo sent->delivered", rc.nextMessageStatus("sent", "echo") === "delivered");
  const list = [
    { id: "m1", from: "u1", status: "delivered" },
    { id: "m2", from: "u2" },
    { id: "m3", from: "u1", status: "sent" },
  ];
  const changed = rc.applyReadReceipt(list, ["m1", "m3"], "u1");
  check("applyReadReceipt elevates only my outbound rows", changed === 2 && list[0]?.status === "read" && list[2]?.status === "read" && list[1]?.status === undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// C) Autonomous HTTP over the real mounted router
// ─────────────────────────────────────────────────────────────────────────────
async function httpRouteTests(rc: ReceiptHelpers): Promise<void> {
  const captured: { room: string; channel: string; payload: Record<string, unknown> }[] = [];
  const fakeIo = {
    to(room: string) {
      return {
        emit(channel: string, payload: Record<string, unknown>) {
          captured.push({ room, channel, payload });
        },
      };
    },
  };
  bindIo(fakeIo as never);

  overrideProviders({
    userExists: (id) => ["u1", "u2", "u3"].includes(id),
    groupMembers: (gid) => (gid === "g1" ? ["u1", "u2", "u3"] : null),
    directThread: (a, b) =>
      a === "u1" && b === "u2"
        ? [
            { id: "b1", from: "u2" },
            { id: "b2", from: "u2" },
          ]
        : [],
    groupThread: (gid) =>
      gid === "g1"
        ? [
            { id: "x1", from: "u1" },
            { id: "x2", from: "u2" },
            { id: "x3", from: "u1" },
            { id: "x4", from: "u3" },
          ]
        : [],
  });

  const { default: messagesRoutes } = await import("../routes/messages.js");
  const { issueAccessToken } = await import("../auth/jwt.js");

  const token = await issueAccessToken({ userId: "u1", deviceId: "d1", sessionId: "s1" });

  const app = express();
  app.use(express.json());
  app.use("/api", messagesRoutes);

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api`;

  async function post(path: string, body: unknown, bearer = token): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
    const json = (await r.json()) as Record<string, unknown>;
    return { status: r.status, json };
  }

  try {
    const noToken = await fetch(`${base}/messages/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    check("HTTP: unauthenticated read -> 401", noToken.status === 401);
    const noTokenJson = (await noToken.json()) as { error: string };
    check("HTTP: unauthenticated error is MISSING_TOKEN", noTokenJson.error === "MISSING_TOKEN");

    const capBefore = captured.length;
    const directRes = await post("/messages/read", rc.buildReadRequest({ from: "u1", isGroup: false, to: "u2", messageId: "b2" }));
    check("HTTP: direct read (exact client body) -> 200", directRes.status === 200 && directRes.json.success === true);
    check("HTTP: direct read returns read-through count 2", directRes.json.read === 2 && directRes.json.messageId === "b2");

    const directPk = captured.slice(capBefore).find((c) => c.channel === "realtime" && c.payload.type === "read" && c.payload.from === "u1" && c.payload.to === "u2");
    check("HTTP: direct read broadcast delivered", directPk !== undefined);
    const directToU2 = captured.slice(capBefore).find((c) => c.room === "user:u2" && c.channel === "realtime" && c.payload.type === "read" && c.payload.from === "u1" && c.payload.to === "u2");
    check("HTTP: direct read broadcast reaches user:u2", directToU2 !== undefined);
    check("HTTP: direct read broadcast messageIds", directToU2 !== undefined && JSON.stringify(directToU2.payload.messageIds) === JSON.stringify(["b1", "b2"]));

    const gCapBefore = captured.length;
    const groupRes = await post("/messages/read", rc.buildReadRequest({ from: "u1", isGroup: true, groupId: "g1", messageId: "x4" }));
    check("HTTP: group read (exact client body) -> 200", groupRes.status === 200 && groupRes.json.success === true);
    const groupPk = captured.slice(gCapBefore).find((c) => c.channel === "realtime" && c.payload.type === "read" && c.payload.groupId === "g1");
    check("HTTP: group read broadcast messageIds (non-u1 rows to x4)", groupPk !== undefined && JSON.stringify(groupPk.payload.messageIds) === JSON.stringify(["x2", "x4"]));

    const mismatch = await post("/messages/read", { from: "u9", type: "direct", to: "u2", messageId: "b1" });
    check("HTTP: body.from != token subject -> 403 from_mismatch", mismatch.status === 403 && mismatch.json.error === "from_mismatch");

    const notFound = await post("/messages/read", { from: "u1", type: "direct", to: "u2", messageId: "zz" });
    check("HTTP: unknown messageId -> 404 read_not_found", notFound.status === 404 && notFound.json.error === "read_not_found");

    const typingCap = captured.length;
    const typingOn = await post("/messages/typing", { from: "u1", type: "direct", to: "u2", typing: true });
    check("HTTP: typing:on -> 200", typingOn.status === 200 && typingOn.json.success === true && typingOn.json.typing === true);
    const typingPk = captured.slice(typingCap).find((c) => c.channel === "realtime" && c.payload.type === "typing" && c.payload.from === "u1");
    check("HTTP: typing:on broadcast wire", typingPk !== undefined && typingPk.payload.typing === true && typingPk.payload.kind === "direct" && typingPk.payload.to === "u2");

    const typingOff = await post("/messages/typing", { from: "u1", type: "direct", to: "u2", typing: false });
    check("HTTP: typing:off with active timer -> 200", typingOff.status === 200 && typingOff.json.typing === false);

    const typingNotMember = await post("/messages/typing", { from: "u1", type: "group", groupId: "gX", typing: true });
    check("HTTP: group typing unknown group -> 403 not_member", typingNotMember.status === 403 && typingNotMember.json.error === "not_member");

    const loginToken = await issueAccessToken({ userId: "u3", deviceId: "d3", sessionId: "s3" });
    const typingOkGroup = await post("/messages/typing", { from: "u3", type: "group", groupId: "g1", typing: true }, loginToken);
    check("HTTP: member group typing:on -> 200", typingOkGroup.status === 200 && typingOkGroup.json.typing === true);

    const ttlCap = captured.length;
    const u2Token = await issueAccessToken({ userId: "u2", deviceId: "d2", sessionId: "s2" });
    await post("/messages/typing", { from: "u2", type: "direct", to: "u1", typing: true }, u2Token);
    await new Promise((r) => setTimeout(r, 180));
    const ttlPk = captured.slice(ttlCap).find((c) => c.channel === "realtime" && c.payload.type === "typing" && c.payload.from === "u2" && c.payload.typing === false);
    check("HTTP: TTL auto-clear broadcast typing:false", Boolean(ttlPk));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    bindIo(null);
    resetProviders();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? "be-5-5-verify-secret";
  process.env.TYPING_TTL_MS = process.env.TYPING_TTL_MS ?? "120";

  const rc = await loadReceipts();

  console.log("BE-5.5 verify: read receipts + typing indicators\n");
  console.log("A) Pure core — read receipts");
  await coreReadTests();
  console.log("A) Pure core — typing");
  coreTypingTests();
  console.log("A) Pure core — typing TTL auto-clear");
  await coreTtlTest();
  console.log("B) Web client wire-body parity");
  clientParityTests(rc);
  console.log("C) Autonomous HTTP over mounted router");
  await httpRouteTests(rc);

  console.log(`\nBE-5.5 verify: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();