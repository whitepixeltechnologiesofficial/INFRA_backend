// hooks/use-permission-state.ts
//
// PERM-2.13 — re-detects a permission granted (or revoked) in device Settings.
// The OS is re-queried on mount and on EVERY return to the foreground, so the
// UI follows the real state without a restart or navigating away and back.

import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { checkPermission, type PermissionKey, type PermissionState } from '@/lib/permissions';

export function usePermissionState(key: PermissionKey): [PermissionState | null, () => Promise<PermissionState>] {
  const [state, setState] = useState<PermissionState | null>(null);

  const refresh = useCallback(async () => {
    const next = await checkPermission(key);
    setState(next);
    return next;
  }, [key]);

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  return [state, refresh];
}
