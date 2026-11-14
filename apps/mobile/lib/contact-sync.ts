// lib/contact-sync.ts
//
// PERM-2.3 — React Native wiring for the sync pipeline in contact-sync-core.
// Starts automatically when Contacts is granted (no extra user action) and
// publishes its status to a small store the New Chat screen subscribes to, so
// the synced list appears as soon as it lands and a failure is visible.

import * as Contacts from 'expo-contacts';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { contactsApi } from '@/api/contactsApi';
import { countryOf } from './contact-hash';
import {
  lookupManualNumber,
  runContactSync,
  type ContactSyncResult,
  type ManualLookup,
  type MatchedUser,
} from './contact-sync-core';

export type SyncState =
  | { status: 'idle' }
  | { status: 'syncing' }
  | { status: 'not_granted' }
  | { status: 'completed'; matches: MatchedUser[]; scanned: number; skipped: number }
  | { status: 'failed'; error: string; uploaded: number };

let state: SyncState = { status: 'idle' };
let inFlight: Promise<SyncState> | null = null;
const listeners = new Set<() => void>();

function setState(next: SyncState) {
  state = next;
  listeners.forEach((l) => l());
}

export const syncStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  getSnapshot: () => state,
};

export function useContactSync(): SyncState {
  return useSyncExternalStore(syncStore.subscribe, syncStore.getSnapshot, syncStore.getSnapshot);
}

async function defaultCountry() {
  return countryOf(await SecureStore.getItemAsync('displayPhone'));
}

function toState(r: ContactSyncResult): SyncState {
  return r.status === 'completed'
    ? { status: 'completed', matches: r.matches, scanned: r.scanned, skipped: r.skipped }
    : { status: 'failed', error: r.error, uploaded: r.uploaded };
}

/** Run (or join) a sync. Never throws; the outcome is in the returned state. */
export function syncContactsFromDevice(): Promise<SyncState> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const { status } = await Contacts.getPermissionsAsync();
      if (status !== 'granted') {
        setState({ status: 'not_granted' });
        return state;
      }
      setState({ status: 'syncing' });
      const result = await runContactSync({
        readPage: async (pageOffset, pageSize) => {
          const page = await Contacts.getContactsAsync({
            pageSize,
            pageOffset,
            fields: [Contacts.Fields.PhoneNumbers],
          });
          return { data: page.data, hasNextPage: page.hasNextPage };
        },
        getSalt: contactsApi.getSalt,
        match: contactsApi.match,
        defaultCountry: await defaultCountry(),
      });
      setState(toState(result));
      return state;
    } catch (e) {
      setState({ status: 'failed', error: e instanceof Error ? e.message : 'CONTACT_SYNC_FAILED', uploaded: 0 });
      return state;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export async function lookupNumber(raw: string): Promise<ManualLookup> {
  return lookupManualNumber(raw, {
    getSalt: contactsApi.getSalt,
    match: contactsApi.match,
    defaultCountry: await defaultCountry(),
  });
}
