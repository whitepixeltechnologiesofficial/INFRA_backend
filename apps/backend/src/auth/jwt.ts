/**
 * LOGIN-3.1 — JWT access token issuance.
 *
 * Every successful login / OTP-verify (LOGIN-3.6) and every token
 * refresh calls `issueAccessToken` to mint a short-lived Bearer
 * credential (Tech Arch §7.1).
 *
 * Token properties:
 *   Algorithm  : HS256 (symmetric, fast, adequate for short-lived tokens)
 *   Expiry     : exactly 1 hour — bounds worst-case kill-switch latency
 *   Claims     : sub (UserId), deviceId, sid (session ID for revocation),
 *                aud ("app") — see TAD §7.4 / §15.3
 *   Verification: `verifyAccessToken` decodes + validates signature + exp
 *                + iss + aud
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { AccessTokenPayload, IssueAccessTokenParams } from "./types.js";

/** Exactly 1 hour — bounds worst-case kill-switch latency (§7.1). */
const ACCESS_TOKEN_EXPIRY = "1h";

const ISSUER = "wpt-backend";

/**
 * Token audiences (TAD §7.4, §15.3).
 *
 * The two token families must not be interchangeable: an end-user access
 * token must never authenticate a dashboard request, or vice versa. `aud`
 * is what enforces that at the verification boundary.
 */
export const AUDIENCE_APP = "app";
export const AUDIENCE_DASHBOARD = "dashboard";

/** HS256 needs at least 256 bits of key material (RFC 7518 §3.2). */
const MIN_SECRET_BYTES = 32;

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "JWT_SECRET is not set. Generate one with: openssl rand -base64 32",
    );
  }
  if (new TextEncoder().encode(secret).byteLength < MIN_SECRET_BYTES) {
    throw new Error(
      `JWT_SECRET is too short — it must be at least ${MIN_SECRET_BYTES} bytes ` +
        `for HS256. Generate one with: openssl rand -base64 32`,
    );
  }
  return new TextEncoder().encode(secret);
}

/**
 * Mint a signed JWT access token.
 *
 * @returns A compact JWT string suitable for `Authorization: Bearer <token>`.
 */
export async function issueAccessToken({
  userId,
  deviceId,
  sessionId,
}: IssueAccessTokenParams): Promise<string> {
  const secret = getSecret();

  const token = await new SignJWT({
      deviceId,
      sid: sessionId,
    })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_APP)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .sign(secret);

  return token;
}

/**
 * Verify a JWT access token and return its parsed payload.
 *
 * Validates:
 *   - Signature (HS256 against JWT_SECRET)
 *   - Expiry (`exp` claim)
 *   - Issuer (`iss` claim)
 *   - Audience (`aud` claim must be `app`) — rejects a dashboard token
 *     presented as a user access token
 *
 * @throws on any verification failure (expired, tampered, wrong issuer,
 *   or wrong audience).
 */
export async function verifyAccessToken(
  token: string,
): Promise<AccessTokenPayload> {
  const secret = getSecret();

  const { payload } = await jwtVerify(token, secret, {
    issuer: ISSUER,
    audience: AUDIENCE_APP,
    // Pin the algorithm — reject alg:none / RS256→HS256 confusion tokens.
    algorithms: ["HS256"],
  });

  return toAccessTokenPayload(payload);
}

/**
 * Decode a JWT **without** verifying the signature.
 *
 * USE ONLY for debugging / logging. Never trust the result for
 * authorization decisions — always call `verifyAccessToken` instead.
 */
export function decodeAccessTokenUnsafe(token: string): JWTPayload {
  const [, payloadB64] = token.split(".");
  if (!payloadB64) throw new Error("Malformed JWT — no payload segment");
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
}

function toAccessTokenPayload(raw: JWTPayload): AccessTokenPayload {
  const sub = typeof raw.sub === "string" ? raw.sub : undefined;
  const deviceId =
    typeof raw.deviceId === "string" ? raw.deviceId : undefined;
  const sid = typeof raw.sid === "string" ? raw.sid : undefined;
  const iat = typeof raw.iat === "number" ? raw.iat : undefined;
  const exp = typeof raw.exp === "number" ? raw.exp : undefined;
  const iss = typeof raw.iss === "string" ? raw.iss : undefined;

  if (!sub || !deviceId || !sid || iat === undefined || exp === undefined || !iss) {
    throw new Error(
      "JWT payload is missing required claims (sub, deviceId, sid, iat, exp, iss)",
    );
  }

  return {
    sub,
    deviceId,
    sid,
    iat,
    exp,
    iss,
  };
}

// ─────────────────────────────────────────────────────────────
// DB-2.5 — Dashboard-admin tokens.
//
// Admins authenticate with a distinct JWT that carries an `adm`
// claim (verifying they are dashboard staff) and no deviceId/sid
// claims (they are not an end-user device session). The secret and
// issuer are the same so the sign/verify plumbing is shared, but
// the token shape is separate from the user access token — and the
// `aud` claim ("dashboard" vs "app") keeps the two families from being
// replayed against each other's endpoints.
// ─────────────────────────────────────────────────────────────

/** Issue a signed JWT for a dashboard admin. */
export async function issueAdminToken(
  adminId: string,
  expiresIn: string = "8h",
): Promise<string> {
  const secret = getSecret();

  const token = await new SignJWT({ adm: "admin" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(adminId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_DASHBOARD)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);

  return token;
}

/**
 * Verify an admin token. Returns the adminId (sub) on success.
 *
 * The `aud` check rejects an end-user access token being replayed against a
 * dashboard endpoint, which the shared secret alone would not prevent.
 */
export async function verifyAdminToken(
  token: string,
): Promise<{ adminId: string }> {
  const secret = getSecret();

  const { payload } = await jwtVerify(token, secret, {
    issuer: ISSUER,
    audience: AUDIENCE_DASHBOARD,
    algorithms: ["HS256"],
  });

  if (payload.adm !== "admin") {
    throw new Error("Not an admin token");
  }

  const sub = typeof payload.sub === "string" ? payload.sub : undefined;
  if (!sub) {
    throw new Error("Admin token missing sub");
  }

  return { adminId: sub };
}
