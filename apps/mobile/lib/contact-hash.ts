import { parsePhoneNumberFromString } from 'libphonenumber-js/mobile';
import { sha256 } from './sha256';

const GLOBAL_SALT = 'onb-contacts-v1_mock_salt';

export function normalizeToE164(raw: string, countryCode?: string): string | null {
  const parsed = parsePhoneNumberFromString(raw, countryCode as any);
  return parsed?.isValid() ? parsed.number : null;
}

export function hashContactNumber(e164: string): string {
  return sha256(e164 + GLOBAL_SALT);
}

export function isContactHash(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash);
}
