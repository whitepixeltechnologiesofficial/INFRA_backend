// lib/onboarding-guard.ts
//
// ONBOARDING GUARD — pure, dependency-free onboarding state logic.
// Node-verifiable so the central navigation guard (resolve-before-render),
// splash routing, and deep-link protection can be asserted in a headless
// harness WITHOUT a device.
//
// SECURITY: the SecureStore snapshot is read-only here — this module NEVER
// writes auth keys. A deep-link / URL is evaluated against the user's ACTUAL
// login status, never treated as proof of identity. `phoneNumber`, `userId`,
// `accessToken`, `deviceId` supplied through a URL never authenticate and
// never reach a protected route on a fresh/unauthenticated session.
//
// This is the reconciled implementation: it exports the tier model + provider
// helpers required by the Team Alpha app (RouteTier / ROUTE_TIERS / SplashAction
// / STORE_KEYS / resolveSnapshot / canAccess / decideSplashAction) AND the
// snapshot-builder used by per-screen guards (OnboardingSnapshot / buildSnapshot).

export interface OnboardingSnapshot {
  legalAccepted: boolean;
  userId: string | null;
  deviceId: string | null;
  hasSession: boolean;
  /** Verified by OTP only; never sourced from URL params. Optional so pure
   *  harness snapshots that omit it remain valid. */
  displayPhone?: string | null;
}

export type RouteTier = 'public' | 'legal_required' | 'session_required';

export type SplashAction = '/legal-acceptance' | '/phone-entry' | '/(tabs)';

export const STORE_KEYS = {
  LEGAL: 'onb.legalAccepted',
  LEGAL_VALUE: 'true',
  USER_ID: 'userId',
  DEVICE_ID: 'deviceId',
  ACCESS_TOKEN: 'accessToken',
  REFRESH_TOKEN: 'refreshToken',
  DISPLAY_PHONE: 'displayPhone',
  PHONE_NUMBER: 'phoneNumber',
} as const;

/** Tier classification for every screen in the root Stack. */
export const ROUTE_TIERS: Record<string, RouteTier> = {
  index: 'public',
  'legal-acceptance': 'public',
  'phone-entry': 'legal_required',
  'otp-entry': 'legal_required',
  'profile-setup': 'session_required',
  'permission-intro': 'session_required',
  'notifications-info': 'session_required',
  'permission-info': 'session_required',
  'device-handoff': 'session_required',
  settings: 'session_required',
  '(tabs)': 'session_required',
  scan: 'session_required',
  'blocked-contacts': 'session_required',
  done: 'public',
  modal: 'public',
};

export const PUBLIC_ROUTES = Object.entries(ROUTE_TIERS)
  .filter(([, t]) => t === 'public')
  .map(([r]) => r);

export const LEGAL_REQUIRED_ROUTES = Object.entries(ROUTE_TIERS)
  .filter(([, t]) => t === 'legal_required')
  .map(([r]) => r);

export const SESSION_REQUIRED_ROUTES = Object.entries(ROUTE_TIERS)
  .filter(([, t]) => t === 'session_required')
  .map(([r]) => r);

export type SecureStorageAdapter = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
};

/**
 * Build an OnboardingSnapshot from SecureStore values for the provider's
 * resolve-before-render guard. Read-only. hasSession is true only when legal
 * acceptance AND a persisted user id AND device id are present.
 */
export async function resolveSnapshot(store: SecureStorageAdapter): Promise<OnboardingSnapshot> {
  const [legalRaw, userId, deviceId] = await Promise.all([
    store.getItemAsync(STORE_KEYS.LEGAL),
    store.getItemAsync(STORE_KEYS.USER_ID),
    store.getItemAsync(STORE_KEYS.DEVICE_ID),
  ]);
  const legalAccepted = legalRaw === STORE_KEYS.LEGAL_VALUE;
  const hasSession = legalAccepted && !!userId && !!deviceId;
  return { legalAccepted, userId, deviceId, hasSession };
}

/**
 * Build an OnboardingSnapshot for the per-screen route guard. Never mutates
 * SecureStore — a pure reader. hasSession requires an access token in addition
 * to a user id (the store only mints the pair together at OTP verify).
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

export function canAccess(snapshot: OnboardingSnapshot, tier: RouteTier): boolean {
  if (tier === 'public') return true;
  if (tier === 'legal_required') return snapshot.legalAccepted;
  return snapshot.hasSession;
}

/** Splash-screen routing: the same legal → phone → session ladder the gates use. */
export function decideSplashAction(snapshot: OnboardingSnapshot): SplashAction {
  if (!snapshot.legalAccepted) return '/legal-acceptance';
  if (!snapshot.hasSession) return '/phone-entry';
  return '/(tabs)';
}