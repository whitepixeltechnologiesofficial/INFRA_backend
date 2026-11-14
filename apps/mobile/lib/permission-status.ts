// lib/permission-status.ts
//
// PERM-2.13 — the app's single permission monitor, bound to the OS and to
// the app lifecycle. Started once from the root layout; every screen reads
// from it through hooks/use-permission-state.ts.
//
// Re-grant side effects (permission granted in device Settings, detected on
// resume):
//   Contacts      -> contact sync starts automatically
//   Notifications -> this device's push token is registered

import { AppState } from 'react-native';
import { createPermissionMonitor, isRegrant } from './permission-monitor';
import { checkPermission } from './permissions';
import { syncContactsFromDevice } from './contact-sync';
import { registerPushToken } from './push';

export const permissionMonitor = createPermissionMonitor({
  check: checkPermission,
  onTransition(key, from, to) {
    if (!isRegrant(from, to)) return;
    if (key === 'contacts') void syncContactsFromDevice();
    if (key === 'notifications') void registerPushToken();
  },
});

let started = false;

export function startPermissionMonitor(): void {
  if (started) return;
  started = true;
  void permissionMonitor.refresh();
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void permissionMonitor.refresh();
  });
}
