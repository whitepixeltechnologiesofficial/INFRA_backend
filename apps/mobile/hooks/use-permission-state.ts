// hooks/use-permission-state.ts
//
// PERM-2.13 — read one permission's live OS state from the app-wide monitor
// (lib/permission-status.ts). The monitor re-checks all five on every
// foreground, so a permission granted in device Settings shows up here the
// moment the user returns, with no restart and no "check again" button.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { permissionMonitor, startPermissionMonitor } from '@/lib/permission-status';
import type { PermissionKey, PermissionState } from '@/lib/permissions';

export function usePermissionState(key: PermissionKey): [PermissionState | null, () => Promise<PermissionState | null>] {
  const snapshot = useSyncExternalStore(permissionMonitor.subscribe, permissionMonitor.getSnapshot, permissionMonitor.getSnapshot);

  useEffect(() => {
    startPermissionMonitor();
  }, []);

  const refresh = useCallback(async () => {
    await permissionMonitor.refresh();
    return permissionMonitor.get(key);
  }, [key]);

  return [snapshot[key] ?? null, refresh];
}
