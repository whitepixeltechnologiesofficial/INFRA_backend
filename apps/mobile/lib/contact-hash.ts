// lib/contact-hash.ts
//
// PERM-2.3 / Tech Arch §6.5, §14.2 — privacy-preserving contact hashing.
//
// A number is normalized to E.164 FIRST (so "098765 43210", "+91 98765-43210"
// and "9876543210" all produce the same digest) and then hashed on the device
// as SHA-256(global_salt + E.164) — the exact formula the backend uses for
// contact_hashes rows (apps/backend/src/utils/phone-hash.ts). The salt comes
// from the backend (GET /contacts/config), so the two can never drift.
//
// Raw numbers never leave this module: only 64-hex digests are returned.

import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/mobile';
import { sha256 } from './sha256';

const HASH_RE = /^[a-f0-9]{64}$/;

export function normalizeToE164(raw: unknown, defaultCountry?: CountryCode): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 40 || !/\d/.test(trimmed) || trimmed.includes('@')) return null;
  try {
    const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
    return parsed && parsed.isValid() ? parsed.number : null;
  } catch {
    return null;
  }
}

/** The country of the user's own number — the right default for local-format contacts. */
export function countryOf(e164OrDisplay: string | null | undefined): CountryCode | undefined {
  if (!e164OrDisplay) return undefined;
  try {
    return parsePhoneNumberFromString(e164OrDisplay.replace(/[^\d+]/g, ''))?.country;
  } catch {
    return undefined;
  }
}

export function hashContactNumber(e164: string, salt: string): string {
  if (!salt) throw new Error('CONTACT_SALT_MISSING');
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) throw new Error('NOT_E164');
  return sha256(salt + e164);
}

export function isContactHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}
