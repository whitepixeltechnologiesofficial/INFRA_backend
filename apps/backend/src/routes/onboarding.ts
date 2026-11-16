/**
 * ONB — Onboarding API routes.
 *
 * Security hardening applied:
 *   - OTP hash comparison uses timing-safe equal (CWE-208)
 *   - Raw OTP code never logged (removed from console.log)
 *   - Phone numbers validated against E.164 format
 *   - Rate limiting on OTP send and verify endpoints
 *   - session/check requires valid JWT (prevents session enumeration)
 *   - login/handoff requires valid refresh token (prevents account takeover)
 *   - OTP attempts use atomic SQL increment (prevents race condition)
 */

import { Router, type Request, type Response } from "express";
import {
  createHmac,
  randomUUID,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { eq, and, isNull, sql } from "drizzle-orm";
import {
  recordLegalAcceptance,
  requireLegalAcceptance,
  LegalAcceptanceRequiredError,
  issueAccessToken,
  issueRefreshToken,
  validateRefreshToken,

  rotateRefreshToken,
  CURRENT_LEGAL_VERSION,

} from "../auth/index.js";
import { getDb } from "../db/index.js";
import { sessions } from "../db/sessions-schema.js";
import { users } from "../db/users-schema.js";
import { devices } from "../db/devices-schema.js";
import { otpVerifications } from "../db/otp-verifications-schema.js";
import { smsOutbox } from "../db/sms-outbox-schema.js";
import { contactHashes } from "../db/contact-hashes-schema.js";
import { pushForceLogout } from "../ws/socket-registry.js";
import { deliverOtpCode } from "../sms/sender.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { phoneHash } from "../utils/phone-hash.js";
import { normalizePhoneNumber } from "../utils/phone-normalize.js";

const router: Router = Router();

// ── OTP config (matches ONB-1.0 mock exactly) ──
const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60_000; // 5 minutes
const MAX_ATTEMPTS = 3;
const LOCKOUT_MS = 30_000; // 30 seconds
const RESEND_COOLDOWN_MS = 30_000; // 30 seconds (independent of lockout)

/**
 * OTP helper functions.
 */
function generateOtpCode(): string {
  // Uniform digits via crypto.randomInt — avoids the modulo bias of byte % 10
  // (which made digits 0-5 ~4% more likely than 6-9 and shrank the search space).
  let code = "";
  for (let i = 0; i < OTP_LENGTH; i++) {
    code += String(randomInt(0, 10));
  }
  return code;
}

/**
 * Hash an OTP code for storage and comparison.
 *
 * Previously `sha256(code)` — an UNSALTED hash over a 1,000,000-value space.
 * That is reversible by brute force in microseconds, so any secondary read of
 * `otp_verifications.code_hash` or `sms_outbox.otp_hash` (a backup, a replica,
 * a log, an injection bug in an unrelated route, an over-broad admin query)
 * yields every live OTP without needing an auth vulnerability at all.
 *
 * HMAC-SHA256 keyed with a server secret removes the offline attack entirely:
 * without the key, an attacker cannot test candidates, because the digest of a
 * guess is not computable. It stays deterministic, which the schema requires —
 * the verify path recomputes the digest and compares, rather than scanning.
 *
 * Keyed by a dedicated secret, not JWT_SECRET, so this key can be rotated
 * independently of token signing.
 */
function hashOtpCode(code: string): string {
  return createHmac("sha256", otpHmacSecret()).update(code).digest("hex");
}

function otpHmacSecret(): string {
  const secret = process.env.OTP_HMAC_SECRET;
  if (!secret) {
    throw new Error(
      "OTP_HMAC_SECRET is not set. Generate one with: openssl rand -base64 32",
    );
  }
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("OTP_HMAC_SECRET must be at least 32 bytes. Generate one with: openssl rand -base64 32");
  }
  return secret;
}

/**
 * Normalize/validate the phone number in the body ahead of rate limiting,
 * so the rate-limit key is the canonical E.164 form (not attacker-varable
 * formatting). Stores the result in res.locals.normalizedPhone.
 */
function withNormalizedPhone(req: Request, res: Response, next: () => void): void {
  const raw = (req.body as { phoneNumber?: unknown } | null)?.phoneNumber;
  if (typeof raw !== "string") {
    res.status(400).json({ error: "phoneNumber is required" });
    return;
  }
  const normalized = normalizePhoneNumber(raw);
  if (!normalized) {
    res.status(400).json({ error: "INVALID_PHONE" });
    return;
  }
  res.locals.normalizedPhone = normalized;
  next();
}

/** Rate-limit key from the normalized phone stored by withNormalizedPhone. */
function normalizedPhoneKey(prefix: string) {
  return (req: Request) => {
    const locals = (req.res?.locals ?? {}) as { normalizedPhone?: string };
    return locals.normalizedPhone ? `${prefix}:${locals.normalizedPhone}` : req.ip ?? req.socket.remoteAddress ?? "unknown";
  };
}

/**
 * Rate-limit key by CALLER IP, independent of the phone number.
 *
 * The per-phone limits alone let anyone who knows a victim's number hold that
 * victim in permanent lockout: `attempts` is monotonic, so once it reaches the
 * threshold every further wrong guess re-arms the 30s lockout, and the check
 * runs before the code comparison — so even a correct code is refused. The
 * attacker only has to keep guessing; the victim can never get in.
 *
 * Capping per IP bounds that regardless of how many numbers one caller targets.
 * Note the underlying store is per-process, so N instances allow N times the
 * limit; that limitation is recorded, not solved here.
 */
function callerIpKey(prefix: string) {
  return (req: Request) => `${prefix}:ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
}

/**
 * Timing-safe comparison of two hex-encoded SHA-256 hashes.
 * Prevents CWE-208 (timing side-channel) on OTP verification.
 */
function timingSafeHashCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * LOGIN-3.4 + §7.3 — Atomic new-device handoff transaction.
 *
 * Called by:
 *   - POST /otp/verify   (OTP success path)
 *   - POST /login/handoff (new-device login, requires valid refresh token)
 */
async function executeHandoffTransaction({
  userId,
  deviceId,
  phoneNumber,
}: {
  userId: string;
  deviceId: string;
  phoneNumber?: string;
}): Promise<{
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  revokedCount: number;
  userId: string;
  routing?: "chats" | "profile_setup";
}> {
  const db = getDb();

  const result = await db.transaction(async (tx) => {
    let routing: "chats" | "profile_setup" | undefined;

    if (phoneNumber) {
      const [, [existingUser]] = await Promise.all([
        tx
          .delete(otpVerifications)
          .where(eq(otpVerifications.phoneNumber, phoneNumber)),
        tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.phoneNumber, phoneNumber))
          .limit(1),
      ]);

      if (existingUser) {
        userId = existingUser.id;
        routing = "chats";
      } else {
        // New user registration — create user + contact_hashes row in same transaction (Tech Arch §14.4)
        userId = randomUUID();
        const hash = phoneHash(phoneNumber);

        await Promise.all([
          tx.insert(users).values({
            id: userId,
            phoneNumber,
            name: "",
          }),
          tx.insert(contactHashes).values({
            phoneHash: hash,
            userId,
          }),
        ]);

        routing = "profile_setup";
      }
    }

    // Ensure a matching device row exists so relay/send (pending_messages
    // sender_device_id uuid FK) works with the device id minted for this session.
    await tx
      .insert(devices)
      .values({
        id: deviceId,
        userId,
        deviceType: "phone",
        platform: "android",
        identityPublicKey: `pf_${deviceId}`,
      })
      .onConflictDoNothing();

    const revokeResult = await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
        ),
      );
    const revokedCount = revokeResult.rowCount ?? 0;

    const { refreshToken, sessionId } = await issueRefreshToken({
      userId,
      deviceId,

      db: tx,

    });
    const accessToken = await issueAccessToken({
      userId,
      deviceId,
      sessionId,
    });

    return { sessionId, accessToken, refreshToken, revokedCount, userId, routing };
  });

  pushForceLogout(userId, deviceId);

  return result;
}

// ──────────────────────────────────────────────────
// POST /onboarding/accept-legal
// ──────────────────────────────────────────────────
router.post("/accept-legal", async (req: Request, res: Response) => {
  try {
    const { phoneNumber: rawPhoneNumber } = req.body as { phoneNumber?: string };

    if (!rawPhoneNumber || typeof rawPhoneNumber !== "string") {
      res.status(400).json({ error: "phoneNumber is required" });
      return;
    }

    // Normalize and validate — without this, an arbitrary string would be
    // stored and later fail to match the E.164 form used by OTP verify
    // (causing a self-DoS) and opens the door to garbage rows.
    const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
    if (!phoneNumber) {
      res.status(400).json({ error: "INVALID_PHONE" });
      return;
    }

    await recordLegalAcceptance({
      phoneNumber,
      legalVersion: CURRENT_LEGAL_VERSION,
    });

    res.json({ success: true });

  } catch {

    console.error("POST /accept-legal error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────
// POST /onboarding/otp/send
// Rate limited: max 3 sends per phone per 60 seconds
// ──────────────────────────────────────────────────
router.post(
  "/otp/send",
  withNormalizedPhone,
  rateLimit({
    maxRequests: 3,
    windowMs: 60_000,
    keyFn: normalizedPhoneKey("otp-send"),
    message: "Too many OTP requests. Please wait before retrying.",
  }),
  rateLimit({
    maxRequests: 10,
    windowMs: 60_000,
    keyFn: callerIpKey("otp-send"),
    message: "Too many OTP requests from this network. Please wait before retrying.",
  }),
  async (_req: Request, res: Response) => {
    try {
      const phoneNumber = (res.locals as { normalizedPhone?: string }).normalizedPhone as string;
      const db = getDb();
      const now = new Date();

      // Resend cooldown check (independent 30s timer, §7.2)
      const [existing] = await db
        .select({ sentAt: otpVerifications.sentAt, lockedUntil: otpVerifications.lockedUntil })
        .from(otpVerifications)
        .where(eq(otpVerifications.phoneNumber, phoneNumber))
        .limit(1);

      // LOGIN-3.6: a locked-out number must not be able to resend (that would
      // delete the row and wipe the lockout). Lockout and cooldown stay independent.
      if (existing?.lockedUntil && now < existing.lockedUntil) {
        res.status(429).json({
          error: "LOCKED_OUT",
          secondsRemaining: Math.ceil((existing.lockedUntil.getTime() - now.getTime()) / 1000),
        });
        return;
      }

      if (existing) {
        const elapsed = now.getTime() - existing.sentAt.getTime();
        if (elapsed < RESEND_COOLDOWN_MS) {
          res.status(429).json({
            error: "RESEND_COOLDOWN_ACTIVE",
            secondsRemaining: Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000),
          });
          return;
        }
      }

      const rawCode = generateOtpCode();
      const codeHash = hashOtpCode(rawCode);
      const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

      // Delete old row + insert new verification + queue SMS outbox row.
      // SECURITY: raw OTP code is NEVER stored in DB — only the SHA-256 hash.
      await Promise.all([
        db
          .delete(otpVerifications)
          .where(eq(otpVerifications.phoneNumber, phoneNumber)),
        db.insert(otpVerifications).values({
          phoneNumber,
          codeHash,
          expiresAt,
          sentAt: now,
        }),
        db.insert(smsOutbox).values({
          phoneNumber,
          otpHash: codeHash,
          status: "pending",
        }),
      ]);

      // Deliver the code. Sends a real SMS when a provider (Twilio) is
      // configured; otherwise prints the code to the server console for dev.
      await deliverOtpCode(phoneNumber, rawCode);

      res.json({ success: true });

    } catch {

      console.error("POST /otp/send error");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ──────────────────────────────────────────────────
// POST /onboarding/otp/verify
// Rate limited: max 5 verify attempts per phone per 60 seconds
// ──────────────────────────────────────────────────
router.post(
  "/otp/verify",
  withNormalizedPhone,
  rateLimit({
    maxRequests: 5,
    windowMs: 60_000,
    keyFn: normalizedPhoneKey("otp-verify"),
    message: "Too many verification attempts. Please wait.",
  }),
  rateLimit({
    maxRequests: 20,
    windowMs: 60_000,
    keyFn: callerIpKey("otp-verify"),
    message: "Too many verification attempts from this network. Please wait.",
  }),
  async (req: Request, res: Response) => {
    try {
      const phoneNumber = (res.locals as { normalizedPhone?: string }).normalizedPhone as string;
      const { code } = req.body as { code?: string };

      if (!code) {
        res.status(400).json({ error: "phoneNumber and code are required" });
        return;
      }

      if (typeof code !== "string" || code.length !== OTP_LENGTH) {
        res.status(400).json({ error: "INVALID_CODE_FORMAT" });
        return;
      }

      // Legal gate check
      try {
        await requireLegalAcceptance(phoneNumber);
      } catch (err) {
        if (err instanceof LegalAcceptanceRequiredError) {
          res.status(err.statusCode).json({ error: err.code });
          return;
        }
        throw err;
      }

      const db = getDb();
      const now = new Date();

      const [record] = await db
        .select()
        .from(otpVerifications)
        .where(eq(otpVerifications.phoneNumber, phoneNumber))
        .limit(1);

      if (!record) {
        res.status(400).json({ error: "NO_ACTIVE_SESSION" });
        return;
      }

      // Lockout check
      if (record.lockedUntil && now < record.lockedUntil) {
        res.json({
          status: "locked_out",
          secondsRemaining: Math.ceil(
            (record.lockedUntil.getTime() - now.getTime()) / 1000,
          ),
        });
        return;
      }

      // LOGIN-3.6: lockout has expired, so start a fresh set of MAX_ATTEMPTS attempts.
      // Without this, attempts stays at 3 and the next wrong code re-locks at once.
      if (record.lockedUntil && now >= record.lockedUntil) {
        await db
          .update(otpVerifications)
          .set({ attempts: 0, lockedUntil: null })
          .where(eq(otpVerifications.phoneNumber, phoneNumber));
        record.attempts = 0;
        record.lockedUntil = null;
      }

      // Expiry check
      if (now.getTime() - record.sentAt.getTime() > OTP_TTL_MS) {
        await db
          .delete(otpVerifications)
          .where(eq(otpVerifications.phoneNumber, phoneNumber));
        res.json({ status: "expired" });
        return;
      }

      // Timing-safe code comparison (CWE-208)
      const presentedHash = hashOtpCode(code);

      if (!timingSafeHashCompare(presentedHash, record.codeHash)) {
        // Wrong code — atomic increment (SET attempts = attempts + 1). A
        // plain per-request read+GREATEST() collapses concurrent guesses into
        // one increment, letting attackers race past the 3-attempt lockout.
        const [updated] = await db
          .update(otpVerifications)
          .set({ attempts: sql`${otpVerifications.attempts} + 1` })
          .where(eq(otpVerifications.phoneNumber, phoneNumber))
          .returning({ attempts: otpVerifications.attempts });

        const attempts = updated?.attempts ?? record.attempts + 1;

        if (attempts >= MAX_ATTEMPTS) {
          const lockedUntil = new Date(now.getTime() + LOCKOUT_MS);
          await db
            .update(otpVerifications)
            .set({ lockedUntil })
            .where(eq(otpVerifications.phoneNumber, phoneNumber));

          res.json({ status: "attempts_exhausted", secondsRemaining: LOCKOUT_MS / 1000 });
          return;
        }

        res.json({ status: "wrong_code", attemptsRemaining: MAX_ATTEMPTS - attempts });
        return;
      }

      // SUCCESS — Atomic handoff transaction
      const deviceId = randomUUID();
      const result = await executeHandoffTransaction({
        userId: "",
        deviceId,
        phoneNumber,
      });

      res.json({
        status: "success",
        routing: result.routing!,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        userId: result.userId,
        sessionId: result.sessionId,
      });

    } catch {

      console.error("POST /otp/verify error");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ──────────────────────────────────────────────────
// POST /onboarding/check-existing-user
// Returns boolean only (no userId) to prevent enumeration
// ──────────────────────────────────────────────────
router.post("/check-existing-user", async (req: Request, res: Response) => {
  try {
    const { phoneNumber: rawPhoneNumber } = req.body as { phoneNumber?: string };

    if (!rawPhoneNumber || typeof rawPhoneNumber !== "string") {
      res.status(400).json({ error: "phoneNumber is required" });
      return;
    }

    const phoneNumber = normalizePhoneNumber(rawPhoneNumber);

    if (!phoneNumber) {
      res.status(400).json({ error: "INVALID_PHONE" });
      return;
    }

    const db = getDb();
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phoneNumber, phoneNumber))
      .limit(1);

    // Only return boolean — never leak userId here
    res.json({ exists: !!existingUser });

  } catch {

    console.error("POST /check-existing-user error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────
// POST /onboarding/refresh
//
// Rotating refresh: every successful call supersedes the presented
// token and returns a replacement. Presenting an already-rotated token
// is treated as reuse and revokes the entire token family.
//
// BREAKING CHANGE: the response now includes `refreshToken`. Clients
// must persist it and discard the old one, or their next refresh will
// be classified as reuse and log them out.
// ──────────────────────────────────────────────────
router.post("/refresh", async (req: Request, res: Response) => {
  try {
    const { refreshToken: presentedToken } = req.body as {
      refreshToken?: string;
    };

    if (!presentedToken) {
      res.status(400).json({ error: "refreshToken is required" });
      return;
    }

    const result = await rotateRefreshToken(presentedToken);

    if (result.status === "reuse_detected") {
      console.error(
        `Refresh token reuse detected; revoked ${result.revokedCount} session(s) in the family`,
      );
      res.status(401).json({
        error: "REFRESH_TOKEN_REUSE",
        message: "This refresh token was already used. All sessions have been revoked.",
      });
      return;
    }

    if (result.status === "invalid") {
      res.status(401).json({ error: "INVALID_REFRESH_TOKEN" });
      return;
    }

    const accessToken = await issueAccessToken({
      userId: result.userId,
      deviceId: result.deviceId,
      sessionId: result.sessionId,
    });


    res.json({ accessToken, refreshToken: result.refreshToken });
  } catch {

    console.error("POST /refresh error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────
// POST /onboarding/login/handoff
//
// SECURITY: Requires a valid refresh token proving the caller owns
// the account. Without this, anyone could mint tokens for any userId.
// ──────────────────────────────────────────────────
router.post("/login/handoff", async (req: Request, res: Response) => {
  try {
    const { refreshToken: presentedToken, deviceInfo } = req.body as {
      refreshToken?: string;
      deviceInfo?: { deviceId: string; deviceName: string; platform: string };
    };

    if (!presentedToken || !deviceInfo) {
      res.status(400).json({
        error: "refreshToken and deviceInfo are required",
      });
      return;
    }

    if (!deviceInfo.deviceId || !deviceInfo.deviceName || !deviceInfo.platform) {
      res.status(400).json({ error: "deviceInfo must include deviceId, deviceName, and platform" });
      return;
    }

    // devices.id is a uuid column — coerce arbitrary client device ids to a
    // uuid so the handoff can bind relay/send (FK on pending_messages.sender_device_id).
    const clientDeviceId = deviceInfo.deviceId;
    const deviceId =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientDeviceId)
        ? clientDeviceId
        : randomUUID();

    // Validate the refresh token — proves the caller owns this account
    const session = await validateRefreshToken(presentedToken);
    if (!session) {
      res.status(401).json({ error: "INVALID_REFRESH_TOKEN" });
      return;
    }

    const handoff = await executeHandoffTransaction({
      userId: session.userId,
      deviceId,
    });

    res.json({
      success: true,
      sessionId: handoff.sessionId,
      accessToken: handoff.accessToken,
      refreshToken: handoff.refreshToken,
      message: `You're now logged in here on ${deviceInfo.deviceName}`,
      previousDevicesLoggedOut: handoff.revokedCount,
    });

  } catch {

    console.error("POST /login/handoff error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────
// POST /onboarding/session/check
//
// SECURITY: Requires valid JWT — prevents session enumeration by
// unauthenticated callers.
// ──────────────────────────────────────────────────
router.post("/session/check", requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = res.locals.auth!.sub;
    const { deviceId } = req.body as { deviceId?: string };

    if (!deviceId) {
      res.status(400).json({ error: "deviceId is required" });
      return;
    }

    const db = getDb();
    const [row] = await db
      .select({ id: sessions.id, revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(and(eq(sessions.userId, authUserId), eq(sessions.deviceId, deviceId)))
      .limit(1);

    if (!row) {
      res.json({ isValid: false, message: "Session not found" });
      return;
    }

    if (row.revokedAt !== null) {
      res.json({ isValid: false, message: "Logged in on another device" });
      return;
    }

    res.json({ isValid: true });

  } catch {

    console.error("POST /session/check error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
