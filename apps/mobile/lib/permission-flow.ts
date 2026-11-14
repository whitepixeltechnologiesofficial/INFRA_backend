// lib/permission-flow.ts
//
// The app's single PERM-2.2 sequence instance: SecureStore-persisted progress
// (survives an app kill) plus the on-grant side effects:
//   Contacts granted      -> contact sync starts automatically (PERM-2.3)
//   Notifications granted -> this device's push token is registered (PERM-2.5)
// Side effects run concurrently with the remaining dialogs; their outcomes are
// kept so the screen can surface a failure instead of failing silently.

import * as SecureStore from 'expo-secure-store';
import {
  createPermissionSequence,
  PERMISSION_ORDER,
  SEQUENCE_STORE_KEY,
  type PermissionKey,
  type Requesters,
} from './permission-sequence';
import { requestPermission, toStepOutcome } from './permissions';
import { syncContactsFromDevice, type SyncState } from './contact-sync';
import { registerPushToken, type PushRegistration } from './push';

const requesters = Object.fromEntries(
  PERMISSION_ORDER.map((key) => [key, async () => toStepOutcome(await requestPermission(key))]),
) as Requesters;

export const sideEffects: {
  contactSync: Promise<SyncState> | null;
  push: Promise<PushRegistration> | null;
} = { contactSync: null, push: null };

function onStep(key: PermissionKey, outcome: string) {
  if (outcome !== 'granted') return;
  if (key === 'contacts') sideEffects.contactSync = syncContactsFromDevice();
  if (key === 'notifications') sideEffects.push = registerPushToken();
}

export const permissionSequence = createPermissionSequence({
  requesters,
  onStep,
  store: {
    get: () => SecureStore.getItemAsync(SEQUENCE_STORE_KEY),
    set: (v) => SecureStore.setItemAsync(SEQUENCE_STORE_KEY, v),
  },
});
