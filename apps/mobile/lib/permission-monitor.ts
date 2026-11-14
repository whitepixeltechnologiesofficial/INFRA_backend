// lib/permission-monitor.ts
//
// PERM-2.13 — the reconciliation layer over all five permissions.
//
// On every foreground/resume (not just cold launch) the monitor re-reads the
// real OS state of all five permissions, compares each one with the last
// state it knew, publishes the new snapshot, and reports every transition.
// A permission re-granted in device Settings therefore takes effect the
// moment the user comes back: no restart, no reinstall, no "check again".
//
// PERM-2.14 — the monitor only ever holds PERMISSION state. Banner dismissal
// lives in lib/banner-dismissal.ts and is never read or written here, so a
// resume check can not resurrect a dismissed banner.
//
// Pure and dependency-injected (verified in Node by scripts/perm-2-verify.ts).

import { PERMISSION_ORDER, type PermissionKey } from './permission-sequence';
import type { PermissionState } from './permissions';

export type PermissionSnapshot = Partial<Record<PermissionKey, PermissionState>>;

export interface PermissionMonitor {
  refresh(): Promise<PermissionSnapshot>;
  get(key: PermissionKey): PermissionState | null;
  getSnapshot(): PermissionSnapshot;
  subscribe(listener: () => void): () => void;
}

/** A re-grant: the permission was refused or unavailable, and now it is granted. */
export function isRegrant(from: PermissionState | undefined, to: PermissionState): boolean {
  return to === 'granted' && (from === 'denied' || from === 'unavailable');
}

export function createPermissionMonitor(opts: {
  check: (key: PermissionKey) => Promise<PermissionState>;
  onTransition?: (key: PermissionKey, from: PermissionState | undefined, to: PermissionState) => void;
}): PermissionMonitor {
  let snapshot: PermissionSnapshot = {};
  let inFlight: Promise<PermissionSnapshot> | null = null;
  const listeners = new Set<() => void>();

  async function readAll(): Promise<PermissionSnapshot> {
    const next: PermissionSnapshot = { ...snapshot };
    const changes: [PermissionKey, PermissionState | undefined, PermissionState][] = [];
    for (const key of PERMISSION_ORDER) {
      let state: PermissionState;
      try {
        state = await opts.check(key);
      } catch {
        state = 'unavailable';
      }
      if (next[key] !== state) {
        changes.push([key, next[key], state]);
        next[key] = state;
      }
    }
    if (changes.length > 0) {
      snapshot = next;
      listeners.forEach((l) => l());
      for (const [key, from, to] of changes) {
        try {
          opts.onTransition?.(key, from, to);
        } catch {
          // a side effect must never break the reconciliation
        }
      }
    }
    return snapshot;
  }

  return {
    refresh() {
      if (!inFlight) {
        inFlight = readAll().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    get: (key) => snapshot[key] ?? null,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
