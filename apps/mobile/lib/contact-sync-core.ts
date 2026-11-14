// lib/contact-sync-core.ts
//
// PERM-2.3 — the address-book -> hashed-batch -> match pipeline, with every
// platform dependency injected so it runs (and is verified) in Node.
//
//  - Each contact is processed on its own: a missing number, a garbage string,
//    an email-only contact or a throw while reading one entry is SKIPPED, it
//    never aborts the sync.
//  - Numbers are normalized to E.164, hashed with the backend's salt, then
//    de-duplicated.
//  - Upload is batched (BATCH_SIZE, below the backend's 1000 cap). A 1,000+
//    contact book is several requests, never one giant payload.
//  - assertHashesOnly() runs on every batch right before it is handed to the
//    network layer: a raw number can not reach the wire even by mistake.
//  - Failure is reported, never swallowed: the result says `failed` and carries
//    how far the sync got.

import type { CountryCode } from 'libphonenumber-js/mobile';
import { hashContactNumber, isContactHash, normalizeToE164 } from './contact-hash';

export const CONTACT_PAGE_SIZE = 500;
export const CONTACT_BATCH_SIZE = 250;

export interface RawContact {
  phoneNumbers?: { number?: string | null }[] | null;
}

export interface MatchedUser {
  id: string;
  name: string;
  photo?: string;
  about: string;
}

export interface ContactSyncDeps {
  readPage(offset: number, pageSize: number): Promise<{ data: RawContact[]; hasNextPage: boolean }>;
  getSalt(): Promise<string>;
  match(hashes: string[]): Promise<MatchedUser[]>;
  defaultCountry?: CountryCode;
}

export type ContactSyncResult =
  | { status: 'completed'; scanned: number; skipped: number; uploaded: number; batches: number; matches: MatchedUser[] }
  | { status: 'failed'; scanned: number; skipped: number; uploaded: number; batches: number; error: string };

export function assertHashesOnly(batch: unknown[]): asserts batch is string[] {
  for (const entry of batch) {
    if (!isContactHash(entry)) throw new Error('RAW_VALUE_BLOCKED');
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runContactSync(deps: ContactSyncDeps): Promise<ContactSyncResult> {
  let scanned = 0;
  let skipped = 0;
  let uploaded = 0;
  let batches = 0;
  try {
    const salt = await deps.getSalt();
    const hashes = new Set<string>();
    let offset = 0;
    for (;;) {
      const page = await deps.readPage(offset, CONTACT_PAGE_SIZE);
      for (const contact of page.data ?? []) {
        scanned += 1;
        let usable = false;
        try {
          for (const pn of contact?.phoneNumbers ?? []) {
            const e164 = normalizeToE164(pn?.number, deps.defaultCountry);
            if (!e164) continue;
            hashes.add(hashContactNumber(e164, salt));
            usable = true;
          }
        } catch {
          usable = false;
        }
        if (!usable) skipped += 1;
      }
      if (!page.hasNextPage || (page.data ?? []).length === 0) break;
      offset += CONTACT_PAGE_SIZE;
    }

    const matches = new Map<string, MatchedUser>();
    for (const batch of chunk([...hashes], CONTACT_BATCH_SIZE)) {
      assertHashesOnly(batch);
      for (const m of await deps.match(batch)) matches.set(m.id, m);
      uploaded += batch.length;
      batches += 1;
    }
    return { status: 'completed', scanned, skipped, uploaded, batches, matches: [...matches.values()] };
  } catch (e) {
    return {
      status: 'failed',
      scanned,
      skipped,
      uploaded,
      batches,
      error: e instanceof Error ? e.message : 'CONTACT_SYNC_FAILED',
    };
  }
}

/**
 * PERM-2.4 — manual number entry. Same endpoint, same hashing, a ONE-ITEM
 * batch: never unchecked free text.
 */
export type ManualLookup =
  | { status: 'invalid' }
  | { status: 'not_registered'; e164: string }
  | { status: 'registered'; e164: string; user: MatchedUser }
  | { status: 'failed'; error: string };

export async function lookupManualNumber(
  raw: string,
  deps: Pick<ContactSyncDeps, 'getSalt' | 'match' | 'defaultCountry'>,
): Promise<ManualLookup> {
  const e164 = normalizeToE164(raw, deps.defaultCountry);
  if (!e164) return { status: 'invalid' };
  try {
    const batch = [hashContactNumber(e164, await deps.getSalt())];
    assertHashesOnly(batch);
    const [user] = await deps.match(batch);
    return user ? { status: 'registered', e164, user } : { status: 'not_registered', e164 };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : 'LOOKUP_FAILED' };
  }
}
