// Backend web-link / web-session primitives.
//
// Opaque tokens everywhere; raw credentials are never stored — only a
// timing-safe, SHA-256 digest of each token is kept (same principle as the
// sessions table's `tokenLookup`). No phone number, userId, accessToken or
// private key ever appears in a QR payload.

import { createHash, randomBytes } from "node:crypto";

/** Stable SHA-256 hex digest of a token — the ONLY thing we store/lookup. */
export function secureHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 32 random bytes → 64 hex chars. Matches the QR parser's ^[0-9a-f]{64}$ rule. */
export function randomToken(): string {
  return randomBytes(32).toString("hex");
}