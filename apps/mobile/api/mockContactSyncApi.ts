// api/mockContactSyncApi.ts
//
// CONTACT SYNC — Mock implementation of the contact-hash sync endpoint
// (backed by DB-2.3 `contact_hashes`). Mirrors the real Signum-style backend
// contract in-memory so the app runs without a backend process.
//
// Contract (Tech Arch §14.2):
//   - Client sends batches of `sha256(normalizedE164 + globalSalt)`.
//   - The endpoint accepts ONLY 64-char hex hashes. Any payload entry that is
//     not a hash — critically, any raw phone number — is rejected outright.
//   - Batches are capped (MAX_BATCH); larger payloads are rejected with an
//     error rather than silently truncated.
//   - The endpoint returns which submitted hashes match registered users.
//
// Screens call `contactSyncApi` exactly like the future live endpoint;
// `mockContactSyncDebug` holds verification helpers for manual testing.
import { hashContactNumber, isContactHash } from '@/lib/contact-hash';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Global salt shared with the client hashing logic (§14.2). In production this
// is distributed via a separate endpoint; here it ships as a constant so both
// sides agree.
export const GLOBAL_SALT = 'onb-contacts-v1_mock_salt';

// Max accepted batch size. Mirrors the real endpoint's 1,000-entry cap.
export const MAX_BATCH = 1000;

// Users the platform knows about (mock registered numbers). Their hashes form
// the "match set" the endpoint compares submitted hashes against.
const MOCK_REGISTERED_NUMBERS = new Set<string>([
  '+14155552671',
  '+911234567890',
  '+919876543210',
]);

// Precomputed registered-user hashes using the same hashing contract as the client.
const registeredHashes = new Set<string>(
  [...MOCK_REGISTERED_NUMBERS].map((e164) => hashContactNumber(e164, GLOBAL_SALT)),
);

// In-memory "contact_hashes" table (simulates the Postgres table in DB-2.3).
const storedContactHashes = new Set<string>();
// Every payload the endpoint has received, kept for manual verification.
const receivedPayloads: string[][] = [];

export type ContactSyncBatchResult = {
  accepted: number;
  matched: number;
  batchCount: number;
  totalRecorded: number;
};

export const contactSyncApi = {
  /**
   * Upload one batch of contact hashes. Returns how many were accepted and how
   * many match registered users. Throws on a malformed payload — including any
   * non-hash entry, i.e. a raw number — or on an oversized batch.
   */
  async syncContactHashes(hashes: string[]): Promise<ContactSyncBatchResult> {
    await delay(150);

    if (!Array.isArray(hashes) || hashes.length === 0) {
      throw Object.assign(new Error('EMPTY_BATCH'), { status: 400 });
    }
    if (hashes.length > MAX_BATCH) {
      throw Object.assign(new Error('BATCH_TOO_LARGE'), { status: 413 });
    }
    if (hashes.some((h: unknown) => typeof h !== 'string' || !isContactHash(h))) {
      // Rejects anything that is not a 64-char SHA-256 hex digest — a raw phone
      // number can never round-trip through this guard.
      throw Object.assign(new Error('INVALID_HASH'), { status: 400 });
    }

    let accepted = 0;
    let matched = 0;
    for (const hash of hashes) {
      storedContactHashes.add(hash);
      accepted += 1;
      if (registeredHashes.has(hash)) {
        matched += 1;
      }
    }
    receivedPayloads.push([...hashes]);

    return {
      accepted,
      matched,
      batchCount: 1,
      totalRecorded: storedContactHashes.size,
    };
  },
};

// ── Verification helpers (manual tests only; screens never use these) ──
export const mockContactSyncDebug = {
  /** True iff every ever-received payload contains ONLY hash-shaped strings. */
  assertOnlyHashesReceived(): boolean {
    return receivedPayloads.every((batch) => batch.every((entry) => isContactHash(entry)));
  },

  receivedPayloadCount(): number {
    return receivedPayloads.length;
  },

  receivedHashCount(): number {
    return receivedPayloads.reduce((sum, batch) => sum + batch.length, 0);
  },

  registeredHash(e164: string): string {
    return hashContactNumber(e164, GLOBAL_SALT);
  },

  matchesRegistered(e164: string): boolean {
    return registeredHashes.has(hashContactNumber(e164, GLOBAL_SALT));
  },

  reset(): void {
    storedContactHashes.clear();
    receivedPayloads.length = 0;
  },
};