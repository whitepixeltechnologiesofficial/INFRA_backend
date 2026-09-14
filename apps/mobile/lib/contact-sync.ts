// lib/contact-sync.ts
//
// CONTACT SYNC — Device-side contact discovery for the mock platform
// (PERM-3 / Tech Arch §6.5, §14.1-14.2, DB-2.3 `contact_hashes`).
//
// Triggered automatically the moment the contacts permission is granted.
// Reads the device address book in pages, normalizes every phone number to
// E.164 (malformed / email-only entries are skipped), hashes each one with the
// global salt, dedupes, and uploads in bounded batches so 1,000+ contacts are
// always sent as multiple batches.
//
// Raw numbers never leave this module: only SHA-256 hex digests are uploaded.
// Failures are surfaced via a structured `ContactSyncError` — never swallowed.
//
// `expo-contacts` is loaded lazily (require, not import) so this module can be
// imported by Node verification harnesses without pulling the native module
// graph, and so a sync that never runs never pays the native-module cost.
let contactsModule: typeof import('expo-contacts') | null = null;
function contacts(): typeof import('expo-contacts') {
  if (!contactsModule) {
    contactsModule = require('expo-contacts') as typeof import('expo-contacts');
  }
  return contactsModule;
}

import { contactSyncApi, GLOBAL_SALT, MAX_BATCH, type ContactSyncBatchResult } from '@/api/mockContactSyncApi';
import { normalizeToE164, hashContactNumber } from '@/lib/contact-hash';

// Page size for reading the address book (independent of upload batching).
const READ_PAGE_SIZE = 500;

// Uploads are chunked well under the endpoint cap, so large lists split into
// many batches instead of one giant overwrought request.
const UPLOAD_BATCH_SIZE = 250;

export type ContactSyncOutcome =
  | { status: 'not_granted' }
  | {
      status: 'completed';
      contactsRead: number;
      validNumbers: number;
      skipped: number;
      uniqueHashes: number;
      matched: number;
      batchesSent: number;
      acceptedHashes: number;
    }
  | {
      status: 'failed';
      message: string;
      contactsRead: number;
      validNumbers: number;
      acceptedHashes: number;
      batchesSent: number;
    };

export class ContactSyncError extends Error {
  readonly contactsRead: number;
  readonly validNumbers: number;
  readonly acceptedHashes: number;
  readonly batchesSent: number;

  constructor(
    message: string,
    details: { contactsRead: number; validNumbers: number; acceptedHashes: number; batchesSent: number },
  ) {
    super(message);
    this.name = 'ContactSyncError';
    this.contactsRead = details.contactsRead;
    this.validNumbers = details.validNumbers;
    this.acceptedHashes = details.acceptedHashes;
    this.batchesSent = details.batchesSent;
  }

  toOutcome(): ContactSyncOutcome {
    return {
      status: 'failed',
      message: this.message,
      contactsRead: this.contactsRead,
      validNumbers: this.validNumbers,
      acceptedHashes: this.acceptedHashes,
      batchesSent: this.batchesSent,
    };
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Read every contact off the device view, returning the deduped contact
 * numbers we could normalize (E.164 form). Malformed / missing entries are
 * skipped — never passed downstream.
 */
async function readDeviceNumbers(): Promise<{ e164Numbers: string[]; contactsRead: number; skipped: number }> {
  const e164Numbers: string[] = [];
  let contactsRead = 0;
  let skipped = 0;

  let pageOffset = 0;
  let hasNextPage = true;

  while (hasNextPage) {
    const { getContactsAsync, Fields } = contacts();
    const { data, hasNextPage: more } = await getContactsAsync({
      pageSize: READ_PAGE_SIZE,
      pageOffset,
      fields: [Fields.PhoneNumbers],
    });

    contactsRead += data.length;

    for (const contact of data) {
      for (const phone of contact.phoneNumbers ?? []) {
        const e164 = normalizeToE164(phone.number, phone.countryCode);
        if (!e164) {
          skipped += 1;
          continue;
        }
        e164Numbers.push(e164);
      }
    }

    hasNextPage = more;
    pageOffset += data.length;
  }

  return { e164Numbers, contactsRead, skipped };
}

/**
 * Sync the device contact list as hashes. Assumes the caller has already
 * requested the contacts permission; if that turns out not to be granted it
 * returns `{ status: 'not_granted' }` instead of guessing.
 *
 * Fires without any further user action and blocks only long enough to send
 * the batches — on grant, sync begins automatically (PERM-3).
 */
export async function syncContactsFromDevice(): Promise<ContactSyncOutcome> {
  const permission = await contacts().getPermissionsAsync();
  // `granted` is true for both full and partial (iOS 18 "limited") access.
  const granted = permission.granted || permission.accessPrivileges === 'limited';
  if (!granted) {
    return { status: 'not_granted' };
  }

  let e164Numbers: string[];
  let contactsRead: number;
  let skipped: number;

  try {
    ({ e164Numbers, contactsRead, skipped } = await readDeviceNumbers());
  } catch (e) {
    throw new ContactSyncError(
      e instanceof Error ? e.message : 'Failed to read device contacts',
      { contactsRead: 0, validNumbers: 0, acceptedHashes: 0, batchesSent: 0 },
    );
  }

  const uniqueHashes = [...new Set(e164Numbers.map((e164) => hashContactNumber(e164, GLOBAL_SALT)))];
  const batches = chunkArray(uniqueHashes, UPLOAD_BATCH_SIZE);

  let matched = 0;
  let acceptedHashes = 0;
  let batchesSent = 0;

  for (const batch of batches) {
    try {
      const res = await contactSyncApi.syncContactHashes(batch);
      matched += res.matched;
      acceptedHashes += res.accepted;
      batchesSent += 1;
    } catch (e) {
      // A failed batch is NOT silent: the caller surfaces this to the user.
      throw new ContactSyncError(e instanceof Error ? e.message : 'Contact sync upload failed', {
        contactsRead,
        validNumbers: e164Numbers.length,
        acceptedHashes,
        batchesSent,
      });
    }
  }

  return {
    status: 'completed',
    contactsRead,
    validNumbers: e164Numbers.length,
    skipped,
    uniqueHashes: uniqueHashes.length,
    matched,
    batchesSent,
    acceptedHashes,
  };
}

// Guards against accidental oversized uploads from the orchestrator side too.
export const SYNC_UPLOAD_BATCH_SIZE = UPLOAD_BATCH_SIZE;
export const SYNC_MAX_BATCH = MAX_BATCH;
export type { ContactSyncBatchResult };