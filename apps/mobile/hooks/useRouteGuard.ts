import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { buildSnapshot, OnboardingSnapshot } from '@/lib/onboarding-guard';
import { resolveRouteGate } from '@/lib/route-guard';

export function useRouteGuard(route: string): OnboardingSnapshot | null {
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await buildSnapshot(SecureStore);
        if (cancelled) return;
        const gate = resolveRouteGate(route, snap);
        if (gate.action === 'redirect') {
          router.replace(gate.to);
          return;
        }
        setSnapshot(snap);
      } catch {
        if (!cancelled) router.replace('/legal-acceptance');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route]);

  return snapshot;
}
