/**
 * PERM-2.3 / 2.4 / 2.5 — backend half of the mobile permissions work,
 * exercised over real HTTP on the mounted routers (no database needed: every
 * check here is decided before the first query).
 *
 *   pnpm --filter @wpt/backend run verify:perm2
 */

import express from "express";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.JWT_SECRET = process.env.JWT_SECRET || "perm2-verify-secret-perm2-verify-secret";
process.env.GLOBAL_SALT = "perm2_backend_salt";
delete process.env.DATABASE_URL;

const { issueAccessToken } = await import("../auth/jwt.js");
const contactsRoutes = (await import("../routes/contacts.js")).default;
const pushRoutes = (await import("../routes/push.js")).default;
const push = await import("./expo-push.js");
const { phoneHash } = await import("../utils/phone-hash.js");

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : `  -> ${JSON.stringify(detail)}`}`);
  }
}

const app = express();
app.use(express.json());
app.use("/api/v1/contacts", contactsRoutes);
app.use("/api/v1/push", pushRoutes);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

const token = await issueAccessToken({
  userId: "11111111-1111-4111-8111-111111111111",
  deviceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
});
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = auth) {
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

try {
  console.log("\nPERM-2.3  contacts config + match input contract");
  const cfg = await call("GET", "/contacts/config");
  check("GET /contacts/config returns the global salt", cfg.status === 200 && cfg.body.salt === "perm2_backend_salt", cfg);
  check("config states the formula the phone must use", cfg.body.order === "salt+e164" && cfg.body.algorithm === "sha256");
  check("config states the batch cap", cfg.body.maxBatch === 1000);
  check("config requires auth", (await call("GET", "/contacts/config", undefined, {})).status === 401);
  delete process.env.GLOBAL_SALT;
  const noSalt = await call("GET", "/contacts/config");
  check("missing salt fails closed (503), never an empty salt", noSalt.status === 503, noSalt);
  process.env.GLOBAL_SALT = "perm2_backend_salt";

  const raw = await call("POST", "/contacts/match", { hashes: ["+919876543210"] });
  check("a raw phone number is rejected (INVALID_HASH)", raw.status === 400 && raw.body.error === "INVALID_HASH", raw);
  const digits = await call("POST", "/contacts/match", { hashes: ["9876543210"] });
  check("bare digits are rejected (INVALID_HASH)", digits.status === 400 && digits.body.error === "INVALID_HASH");
  const big = await call("POST", "/contacts/match", { hashes: Array.from({ length: 1001 }, () => phoneHash("+919876543210")) });
  check("a batch over 1000 is rejected (BATCH_TOO_LARGE)", big.status === 400 && big.body.error === "BATCH_TOO_LARGE", big.body);
  const empty = await call("POST", "/contacts/match", { hashes: [] });
  check("empty batch is a no-op", empty.status === 200 && Array.isArray(empty.body.matches) && (empty.body.matches as unknown[]).length === 0);
  check("match requires auth", (await call("POST", "/contacts/match", { hashes: [] }, { "Content-Type": "application/json" })).status === 401);

  console.log("\nPERM-2.5  push token registration + delivery");
  const badTok = await call("POST", "/push/register", { token: "fcm-raw-token", platform: "android" });
  check("non-Expo token rejected (INVALID_TOKEN)", badTok.status === 400 && badTok.body.error === "INVALID_TOKEN", badTok);
  const badPlat = await call("POST", "/push/register", { token: "ExponentPushToken[abc123]", platform: "web" });
  check("unsupported platform rejected", badPlat.status === 400 && badPlat.body.error === "INVALID_PLATFORM", badPlat);
  check("register requires auth", (await call("POST", "/push/register", { token: "ExponentPushToken[abc]", platform: "ios" }, { "Content-Type": "application/json" })).status === 401);
  check("token shape guard", push.isExpoPushToken("ExponentPushToken[xYz_12-3]") && !push.isExpoPushToken("ExponentPushToken[]") && !push.isExpoPushToken(42));

  const alert = push.buildMessageAlert("ExponentPushToken[abc]");
  check("alert carries NO message content (E2E)", alert.title === "New message" && JSON.stringify(alert).match(/ciphertext|text"/) === null);
  check("alert targets the HIGH-importance messages channel", alert.channelId === "messages" && alert.priority === "high");

  const sent: { url: string; body: unknown }[] = [];
  push.overridePushFetch(async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  });
  const r1 = await push.sendExpoPush(["ExponentPushToken[a1]", "garbage", "ExponentPushToken[b2]"]);
  check("send goes to Expo push service with only valid tokens", r1.sent === 2 && sent[0]?.url === push.EXPO_PUSH_URL && (sent[0]?.body as unknown[]).length === 2);
  process.env.PUSH_DISABLED = "1";
  const r2 = await push.sendExpoPush(["ExponentPushToken[a1]"]);
  check("PUSH_DISABLED=1 switches sends off", r2.sent === 0 && sent.length === 1);
  delete process.env.PUSH_DISABLED;
  push.overridePushFetch(async () => {
    throw new Error("network down");
  });
  const r3 = await push.sendExpoPush(["ExponentPushToken[a1]"]);
  check("a transport failure never throws (relay send is never failed by push)", r3.ok === false);
  push.overridePushFetch(null);

  const here = dirname(fileURLToPath(import.meta.url));
  const relay = readFileSync(join(here, "..", "routes", "relay.ts"), "utf8");
  check("relay pushes only to devices with no live socket", /!r\.pushed && r\.recipientDeviceId/.test(relay));
  check("relay push is fire-and-forget (void ... .catch)", /void db[\s\S]*?\.catch\(/.test(relay));
  const migration = readFileSync(join(here, "..", "db", "migrations", "019_push_tokens.sql"), "utf8");
  check("push_tokens rows die with their device", /REFERENCES devices\(id\) ON DELETE CASCADE/.test(migration));
} finally {
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
