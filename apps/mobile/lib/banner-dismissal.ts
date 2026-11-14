// lib/banner-dismissal.ts
//
// PERM-2.14 — banner dismissal is SESSION-scoped: once dismissed, a denial
// banner stays hidden for the rest of this app session, and comes back after
// an app restart. Deliberately module memory only — nothing is persisted.

import { useSyncExternalStore } from 'react';

const dismissed = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version += 1;
  listeners.forEach((l) => l());
}

export function isBannerDismissed(permissionId: string): boolean {
  return dismissed.has(permissionId);
}

export function dismissBanner(permissionId: string): void {
  if (dismissed.has(permissionId)) return;
  dismissed.add(permissionId);
  notify();
}

/** Simulates an app restart (tests only): the session's dismissals are gone. */
export function resetBannerDismissals(): void {
  dismissed.clear();
  notify();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useBannerDismissed(permissionId: string): boolean {
  useSyncExternalStore(subscribe, () => version, () => version);
  return dismissed.has(permissionId);
}
