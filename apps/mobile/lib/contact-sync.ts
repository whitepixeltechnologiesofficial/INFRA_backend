import * as Contacts from 'expo-contacts';
import { hashContactNumber, normalizeToE164 } from './contact-hash';

export type SyncStatus = 'not_granted' | 'completed' | 'failed';

export class ContactSyncError extends Error {
  constructor(public processed: number, public total: number, message: string) {
    super(message);
  }
}

export async function syncContactsFromDevice(): Promise<SyncStatus> {
  const { status } = await Contacts.getPermissionsAsync();
  if (status !== 'granted') return 'not_granted';

  try {
    let pageOffset = 0;
    const pageSize = 500;
    let hasMore = true;

    const hashes = new Set<string>();

    while (hasMore) {
      const { data, hasNextPage } = await Contacts.getContactsAsync({
        pageSize,
        pageOffset,
        fields: [Contacts.Fields.PhoneNumbers],
      });

      for (const contact of data) {
        if (contact.phoneNumbers) {
          for (const pn of contact.phoneNumbers) {
            const e164 = normalizeToE164(pn.number || '');
            if (e164) {
              hashes.add(hashContactNumber(e164));
            }
          }
        }
      }

      hasMore = hasNextPage;
      pageOffset += pageSize;
    }

    const hashArray = Array.from(hashes);
    const BATCH_SIZE = 250;

    for (let i = 0; i < hashArray.length; i += BATCH_SIZE) {
      const batch = hashArray.slice(i, i + BATCH_SIZE);
      // await mockContactSyncApi.syncContactHashes(batch);
    }

    return 'completed';
  } catch (e) {
    console.error('Contact sync failed', e);
    return 'failed';
  }
}
