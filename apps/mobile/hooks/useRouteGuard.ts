// hooks/useRouteGuard.ts
//
// The single mount-time guard every protected screen uses. Reads the durable
// SecureStore snapshot, runs the centralized `resolveRouteGate` decision, and:
//   - on BLOCK: redirects with a PLAIN string route (ALL query params discarded —
//     an attacker-supplied phoneNumber/userId/token is never forwarded), and the
//     screen keeps rendering null until it is unmounted;
//   - on ALLOW: returns the snapshot so the screen can render the VERIFIED
//     identity (e.g. `displayPhone` persisted by OTP) instead of trusting URL
//     params.
// Screens call it at the top and render nothing until the snapshot is returned,
// so a protected screen can never paint untrusted URL content even for one frame.

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
          // Discard every query param — never forward identity-bearing values.
          router.replace(gate.to);
          return;
        }
        setSnapshot(snap);
      } catch {
        // Storage failure — block closed by default rather than risk exposure.
        if (!cancelled) router.replace('/legal-acceptance');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route]);

  return snapshot;
}