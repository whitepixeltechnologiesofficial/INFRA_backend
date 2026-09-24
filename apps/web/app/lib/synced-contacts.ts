// WEB-2.4 — New Chat reads ONLY server-matched synced contacts.
//
// Locked design decision (Section 5): Web never opens a browser Contacts
// prompt. The New Chat panel instead queries the relay/backend for the
// account's ALREADY-synced contact matches (the mobile app uploads only
// SHA-256 hashes of the address book — PERM-2.16). So:
//   - the client only ever renders what the server reports as matched;
//   - raw phone numbers never appear here and nothing is uploaded from Web;
//   - zero synced contacts is a first-class empty state, not an error.
// This module is self-contained and erasable-only so Node harnesses import it
// directly with type stripping.

export interface SyncedContact {
  id: string;
  name: string;
  role?: string;
}

export interface SyncedContactsPayload {
  ok: boolean;
  synced: SyncedContact[];
}

export const SYNCED_CONTACTS_ROUTE = "/api/synced-contacts";

export const EMPTY_SYNCED_CONTACTS_COPY =
  "No contacts synced yet. People you've synced from your phone appear here when they're on Sealine.";

export const SYNCED_NO_MATCH_COPY =
  "No synced contact matches this search — if they join Sealine later, their synced number becomes a chat here automatically.";

export function buildSyncedContactsPath(webToken: string): string {
  return `${SYNCED_CONTACTS_ROUTE}/${encodeURIComponent(webToken)}`;
}

export function isSyncedContactsPayload(value: unknown): value is SyncedContactsPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as SyncedContactsPayload;
  return (
    v.ok === true &&
    Array.isArray(v.synced) &&
    v.synced.every((c) => !!c && typeof c === "object" && typeof c.id === "string" && typeof c.name === "string")
  );
}

// Server-side match contract. `matchedIds` is the relay's resolution of which
// registered users the account's synced address book hashes belong to. The
// pure result mirrors the relay: matched users only, self excluded, deduped,
// presented in the server's user order (never client-supplied order).
export function matchSyncedContacts(allUsers: readonly SyncedContact[], meId: string, matchedIds: readonly string[]): SyncedContact[] {
  const kept = new Set<string>();
  for (const raw of matchedIds) {
    const id = String(raw ?? "").trim();
    if (id && id !== meId) kept.add(id);
  }
  return allUsers.filter((u) => kept.has(u.id));
}

// Local search over the already-matched list. An empty query returns the whole
// matched list; otherwise a case-insensitive match on name or id.
export function filterSyncedContacts(synced: readonly SyncedContact[], query: string): SyncedContact[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...synced];
  return synced.filter((u) => u.name.toLowerCase().includes(needle) || u.id.toLowerCase().includes(needle));
}