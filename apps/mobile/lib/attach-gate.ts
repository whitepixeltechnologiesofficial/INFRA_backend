// lib/attach-gate.ts
//
// PERM-2.9 – PERM-2.12 — Camera and Photos/Files are two INDEPENDENT gates.
// Each attach option is decided only from its own permission's state, so a
// denied Camera can never disable or grey out "attach existing photo", and
// vice versa. Pure, verified in Node.

import type { PermissionState } from './permissions';

export type AttachAction = 'open' | 'ask' | 'settings';

export function decideAttachAction(state: PermissionState | null): AttachAction {
  if (state === 'granted') return 'open';
  if (state === 'unknown' || state === null) return 'ask';
  return 'settings';
}

export type AttachSource = 'camera' | 'photos';

/** Both options are always offered; availability never depends on the other permission. */
export function attachOptions(): AttachSource[] {
  return ['camera', 'photos'];
}
