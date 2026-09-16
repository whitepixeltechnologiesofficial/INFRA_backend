// lib/onboarding-guard.ts
//
// SecureStore snapshot used by the deep-link / QR security gate.
// Read-only; never writes. Pure and dependency-free (Node-verifiable).
//
// The snapshot captures durable auth state at decision time so that a
// scanned deep link is evaluated against the user's ACTUAL login status
// rather than being trusted as proof of identity.

export interface OnboardingSnapshot {
  legalAccepted: boolean;
  userId: string | null;
  deviceId: string | null;
  hasSession: boolean;
  /** Verified by OTP only; never sourced from URL params. Optional so pure
   *  harness snapshots that omit it remain valid. */
  displayPhone?: string | null;
}

/**
 * Build an OnboardingSnapshot from SecureStore values. Call once at
 * decision time (e.g. on AppState foreground or before route gating).
 * Never mutate SecureStore — this is a pure reader.
 */
export async function buildSnapshot(
  SecureStore: {
    getItemAsync: (key: string) => Promise<string | null>;
  },
): Promise<OnboardingSnapshot> {
  const [legalAccepted, userId, deviceId, accessToken, displayPhone] = await Promise.all([
    SecureStore.getItemAsync('onb.legalAccepted'),
    SecureStore.getItemAsync('userId'),
    SecureStore.getItemAsync('deviceId'),
    SecureStore.getItemAsync('accessToken'),
    SecureStore.getItemAsync('displayPhone'),
  ]);
  return {
    legalAccepted: legalAccepted === 'true',
    userId: userId ?? null,
    deviceId: deviceId ?? null,
    hasSession: !!userId && !!accessToken,
    displayPhone: displayPhone ?? null,
  };
}
