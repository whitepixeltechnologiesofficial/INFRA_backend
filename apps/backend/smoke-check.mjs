import "dotenv/config";
import pgMod from "pg";
import { SignJWT } from "jose";

const pg = pgMod;
const BASE = process.env.SMOKE_BASE || "http://localhost:4000/api/v1";
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  family: 4,
  connectionTimeoutMillis: 8000,
  ssl: { rejectUnauthorized: false },
});

const T = (+Date.now()).toString().slice(-4);
const PHONE = `+1212555${T}`;
const OTHER_PHONE = `+1212556${T}`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
}

async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

async function main() {
  const seed = Buffer.from(T).toString("hex"); 
  // 1. health
  const h = await api("GET", "/health");
  check("GET /health", h.status === 200 && h.body?.ok === true, JSON.stringify(h.body));

  // 2. check-existing-user fresh
  const ck = await api("POST", "/onboarding/check-existing-user", { phoneNumber: PHONE });
  check("check-existing-user (fresh)", ck.status === 200 && ck.body?.exists === false, JSON.stringify(ck.body));

  // 3. check-existing-user invalid phone
  const ckBad = await api("POST", "/onboarding/check-existing-user", { phoneNumber: "nope" });
  check("check-existing-user (invalid phone 400)", ckBad.status === 400, JSON.stringify(ckBad.body));

  // 4. otp/send
  const snd = await api("POST", "/onboarding/otp/send", { phoneNumber: PHONE });
  check("otp/send", snd.status === 200 && snd.body?.success === true, JSON.stringify(snd.body));

  // brute-force the OTP code by matching its SHA-256 hash in the DB
  let code = null;
  const row = await pool.query("SELECT code_hash FROM otp_verifications WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1", [PHONE]).then((r) => r.rows[0]);
  const { createHash } = await import("node:crypto");
  if (row) {
    for (let i = 0; i < 1000000; i++) {
      const c = String(i).padStart(6, "0");
      if (createHash("sha256").update(c).digest("hex") === row.code_hash) { code = c; break; }
    }
  }
  check("otp code recoverable from DB hash", !!code, code);
  // 5. verify without legal -> LEGAL_NOT_ACCEPTED
  const v0 = await api("POST", "/onboarding/otp/verify", { phoneNumber: PHONE, code });
  check("otp/verify before legal (gate)", v0.body?.error === "LEGAL_NOT_ACCEPTED" || v0.status === 400 || v0.status === 403, JSON.stringify(v0.body));

  // 6. accept-legal
  const al = await api("POST", "/onboarding/accept-legal", { phoneNumber: PHONE });
  check("accept-legal", al.status === 200 && al.body?.success === true, JSON.stringify(al.body));

  // 7. wrong code
  const wrong = await api("POST", "/onboarding/otp/verify", { phoneNumber: PHONE, code: String((+code + 1) % 1000000).padStart(6, "0") });
  check("otp/verify wrong code", wrong.body?.status === "wrong_code" && wrong.body?.attemptsRemaining === 2, JSON.stringify(wrong.body));

  // 8. correct verify
  const okv = await api("POST", "/onboarding/otp/verify", { phoneNumber: PHONE, code, deviceType: "phone", platform: "android", deviceName: "SmokeDev" });
  console.log("VERIFY RAW RESPONSE:", JSON.stringify({status: okv.status, body: okv.body}));
  check("otp/verify success", okv.status === 200 && okv.body?.accessToken && okv.body?.refreshToken, `routing=${okv.body?.routing}`);
  const accessToken = okv.body?.accessToken;
  const refreshToken = okv.body?.refreshToken;
  const userId = okv.body?.userId;
  const deviceId = okv.body?.deviceId || okv.body?.sessionId;

  // need auth-token deviceId from JWT payload
  let authDeviceId = deviceId;
  if (accessToken) {
    try { authDeviceId = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString()).deviceId; } catch {}
  }

  // 9. session/check
  const sc = await api("POST", "/onboarding/session/check", { deviceId: authDeviceId }, accessToken);
  check("session/check valid", sc.status === 200 && sc.body?.isValid === true, JSON.stringify(sc.body));

  // 10. session/check no token -> 401
  const sc1 = await api("POST", "/onboarding/session/check", { deviceId: authDeviceId });
  check("session/check no auth 401", sc1.status === 401, JSON.stringify(sc1.body));

  // 11. refresh
  const rf = await api("POST", "/onboarding/refresh", { refreshToken });
  check("onboarding/refresh", rf.status === 200 && !!rf.body?.accessToken, JSON.stringify(rf.body));

  // 12. login/handoff
  const lh = await api("POST", "/onboarding/login/handoff", { refreshToken, deviceInfo: { deviceId: authDeviceId, deviceName: "Smoke2", platform: "android" } });
  check("login/handoff", lh.status === 200 && lh.body?.success === true, JSON.stringify(lh.body));
  const refreshedAccess = lh.body?.accessToken || accessToken;

  // 13. profile/create
  const pc = await api("POST", "/profile/create", { name: "Smoke Tester", about: "smoke about" }, refreshedAccess);
  check("profile/create", pc.status === 200 && pc.body?.success === true, JSON.stringify(pc.body));

  // 14. profile/get
  const pg1 = await api("POST", "/profile/get", {}, refreshedAccess);
  check("profile/get", pg1.status === 200 && pg1.body?.name === "Smoke Tester", JSON.stringify(pg1.body));

  // 15. profile/update
  const pu = await api("POST", "/profile/update", { name: "Smoke Updated", about: "updated" }, refreshedAccess);
  check("profile/update", pu.status === 200 && pu.body?.profile?.name === "Smoke Updated", JSON.stringify(pu.body));

  // 16. profile without token 401
  const p0 = await api("POST", "/profile/get", {});
  check("profile no auth 401", p0.status === 401, JSON.stringify(p0.body));

  // 17. blocks/block
  const bl = await api("POST", "/blocks/block", { blockedPhone: OTHER_PHONE }, refreshedAccess);
  check("blocks/block", bl.status === 200 && bl.body?.success === true, JSON.stringify(bl.body));
  const blockedHash = bl.body?.blockedPhoneHash;

  // 18. blocks/check
  const bc = await api("POST", "/blocks/check", { blockedPhone: OTHER_PHONE }, refreshedAccess);
  check("blocks/check", bc.status === 200 && bc.body?.isBlocked === true, JSON.stringify(bc.body));

  // 19. blocks/list
  const bls = await api("POST", "/blocks/list", {}, refreshedAccess);
  check("blocks/list", bls.status === 200 && Array.isArray(bls.body?.blockedPhoneHashes) && bls.body.blockedPhoneHashes.includes(blockedHash), JSON.stringify(bls.body));

  // 20. blocks/unblock by hash
  const unb = await api("POST", "/blocks/unblock", { blockedPhoneHash: blockedHash }, refreshedAccess);
  check("blocks/unblock", unb.status === 200 && unb.body?.success === true, JSON.stringify(unb.body));

  // 21. blocks/check after unblock
  const bc2 = await api("POST", "/blocks/check", { blockedPhone: OTHER_PHONE }, refreshedAccess);
  check("blocks/check after unblock", bc2.status === 200 && bc2.body?.isBlocked === false, JSON.stringify(bc2.body));

  // 22. reports/file
  const rep = await api("POST", "/reports/file", { reportedPhone: OTHER_PHONE, reason: "smoke test", messages: [{ content: "bad msg 1" }, { content: "bad msg 2" }] }, refreshedAccess);
  check("reports/file", rep.status === 200 && !!rep.body?.reportId, JSON.stringify(rep.body));
  const reportId = rep.body?.reportId;

  // 23. reports/list
  const rl = await api("POST", "/reports/list", {}, refreshedAccess);
  check("reports/list", rl.status === 200 && rl.body?.reports?.some((r) => r.id === reportId), JSON.stringify(rl.body));

  // 24. reports/get
  const rg = await api("POST", "/reports/get", { reportId }, refreshedAccess);
  check("reports/get", rg.status === 200 && rg.body?.id === reportId && rg.body?.decryptedMessageSnapshot !== undefined, JSON.stringify(rg.body));

  // 25. reports/get other's report -> 404 (IDOR guard)
  const rg2 = await api("POST", "/reports/get", { reportId: "00000000-0000-0000-0000-000000000000" }, refreshedAccess);
  check("reports/get missing 404", rg2.status === 404, JSON.stringify(rg2.body));

  // relay: insert a device row for our user so fan-out has a target
  const devId = `dev_${Date.now()}_${seed}`;
  const devUuid = await pool.query("SELECT gen_random_uuid() AS id").then((r) => r.rows[0].id);
  try {
    await pool.query(
      "INSERT INTO devices (id, user_id, device_type, platform, identity_public_key, is_active, linked_at) VALUES ($1,$2,$3,$4,$5,true,now())",
      [devUuid, userId, "phone", "android", Buffer.from("x".repeat(8)).toString("base64")],
    );
  } catch (e) { console.log("device seed skip FULL:", e.message); }

  // 26. relay/send to self (fan-out by userId)
  const rs = await api("POST", "/relay/send", { recipientUserId: userId, ciphertext: "deadbeefcafe", messageType: "text" }, refreshedAccess);
  check("relay/send (fan-out)", rs.status === 200 && rs.body?.count >= 1, JSON.stringify(rs.body));
  const relayId = rs.body?.rows?.[0]?.id;

  // 27. relay/poll
  const rp = await api("POST", "/relay/poll", { deviceId: devUuid }, refreshedAccess);
  check("relay/poll", rp.status === 200 && rp.body?.messages?.length >= 1, JSON.stringify(rp.body));
  const polledId = rp.body?.messages?.[0]?.id;

  // 28. relay/ack
  const ra = await api("POST", "/relay/ack", { messageId: polledId || relayId }, refreshedAccess);
  check("relay/ack", ra.status === 200 && ra.body?.success === true, JSON.stringify(ra.body));

  // 29. relay/send invalid (two recipients)
  const rb = await api("POST", "/relay/send", { recipientUserId: userId, recipientDeviceId: devUuid, ciphertext: "aa" }, refreshedAccess);
  check("relay/send 2 recipients 400", rb.status === 400, JSON.stringify(rb.body));

  // 30. relay/send no ciphertext
  const rc = await api("POST", "/relay/send", { recipientUserId: userId }, refreshedAccess);
  check("relay/send missing ciphertext 400", rc.status === 400, JSON.stringify(rc.body));

  // 31. unrestricted endpoints require auth
  const n1 = await api("POST", "/blocks/list", {});
  const n2 = await api("POST", "/relay/poll", {});
  const n3 = await api("POST", "/reports/list", {});
  check("blocks/list no auth 401", n1.status === 401);
  check("relay/poll no auth 401", n2.status === 401);
  check("reports/list no auth 401", n3.status === 401);

  // ── Moderation (admin-gated) ──
  // mint an admin token for the existing owner
  const adminId = "c107d002-0cee-4317-baf3-0d3b3fa63c67";
  const adminToken = await new SignJWT({ adm: "admin" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(adminId)
    .setIssuer("wpt-backend")
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));

  // 32. moderation without admin token -> 401
  const m0 = await api("POST", "/moderation/warn", { reportId, adminId }, refreshedAccess);
  check("moderation user token 401", m0.status === 401, JSON.stringify(m0.body));

  // create a fresh report for moderation
  const rep2 = await api("POST", "/reports/file", { reportedPhone: "+1212557000", reason: "mod smoke", messages: [{ content: "x" }] }, refreshedAccess);
  let modReport = rep2.body?.reportId;

  // 33. moderation/warn
  const mw = await api("POST", "/moderation/warn", { reportId: modReport, adminId }, adminToken);
  check("moderation/warn", mw.status === 200 && mw.body?.success === true, JSON.stringify(mw.body));

  // 34. moderation/warn bad admin -> 404
  const mw2 = await api("POST", "/moderation/warn", { reportId: modReport, adminId: "00000000-0000-0000-0000-000000000000" }, adminToken);
  check("moderation bad admin 404", mw2.status === 404, JSON.stringify(mw2.body));

  // 35. moderation/warn missing report
  const mw3 = await api("POST", "/moderation/warn", { reportId: "00000000-0000-0000-0000-000000000000", adminId }, adminToken);
  check("moderation missing report 404", mw3.status === 404, JSON.stringify(mw3.body));

  // 36. moderation/dismiss
  const md = await api("POST", "/moderation/dismiss", { reportId: modReport, adminId }, adminToken);
  check("moderation/dismiss", md.status === 200, JSON.stringify(md.body));

  // 37. moderation/restrict
  const mr = await api("POST", "/moderation/restrict", { reportId: modReport, adminId }, adminToken);
  check("moderation/restrict", mr.status === 200, JSON.stringify(mr.body));

  // 38. moderation/ban
  const mb = await api("POST", "/moderation/ban", { reportId: modReport, adminId }, adminToken);
  check("moderation/ban", mb.status === 200, JSON.stringify(mb.body));

  // 39. debug endpoints off in prod-config (DEBUG not set)
  const d1 = await api("GET", "/debug/tables");
  const d2 = await api("GET", "/debug/admin-token");
  check("debug/tables gated (404)", d1.status === 404);
  check("debug/admin-token gated (404)", d2.status === 404);

  // 40. unknown route 404
  const u = await api("GET", "/nope");
  check("unknown route 404", u.status === 404);

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n==== ${pass}/${results.length} PASSED ====`);
  results.filter((r) => !r.ok).forEach((r) => console.log("  FAILED:", r.name, "-", r.detail));
  await pool.end().catch(() => {});
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });