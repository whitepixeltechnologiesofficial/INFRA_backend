// lib/contact-hash.ts
//
// CONTACT-HASH — Hashing for contact discovery (Tech Arch §6.5, §14.1-14.2,
// DB-2.3 `contact_hashes`).
//
// Every contact phone number is normalized to E.164 and hashed with
// SHA-256(normalizedE164 + globalSalt). Raw numbers never leave the device —
// only the 64-char hex digest is sent. Malformed / unparseable entries return
// `null` and are skipped by the caller, never sent.
import { parsePhoneNumberFromString } from 'libphonenumber-js/mobile';
import { sha256Hex } from '@/lib/sha256';

function asCountryCode(value?: string | null): Parameters<typeof parsePhoneNumberFromString>[1] {
  if (!value || value.length !== 2) {
    return undefined;
  }
  return value.toUpperCase() as Parameters<typeof parsePhoneNumberFromString>[1];
}

/**
 * Normalize a raw contact number to international E.164 form
 * (e.g. "+14155552671"). `countryCode` is an optional region hint (ISO-3166-1
 * alpha-2, e.g. "US") used when the raw number has no leading "+".
 *
 * Returns null for inputs that cannot be confidently normalized (malformed,
 * missing, email-only, etc.) so callers can skip them.
 */
export function normalizeToE164(
  raw: string | null | undefined,
  countryCode?: string | null,
): string | null {
  if (!raw || !raw.trim()) {
    return null;
  }

  const cleaned = raw.trim();

  const parsed = parsePhoneNumberFromString(cleaned, asCountryCode(countryCode));

  return parsed && parsed.isValid() ? parsed.number : null;
}

/**
 * Hash a normalized E.164 number with the global salt.
 * SHA-256(normalizedE164 + globalSalt) — the concatenation contract that both
 * client and server must agree on (§14.2).
 */
export function hashContactNumber(e164: string, globalSalt: string): string {
  return sha256Hex(`${e164}${globalSalt}`);
}

/**
 * True if `value` looks like a SHA-256 hex digest (64 lowercase hex chars).
 * Used by the mock sync endpoint to reject any payload entry that is NOT a
 * hash — a belt-and-suspenders guarantee that raw numbers are never stored.
 */
export function isContactHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}