// lib/onboarding-guard.ts
//
// ONB-1.1 — Pure, dependency-free onboarding guard logic. Node-verifiable so
// the central navigation guard (resolve-before-render) + deep-link protection
// can be asserted in a headless harness WITHOUT a device.

export type RouteTier = 'public' | 'legal_required' | 'session_required';

export interface OnboardingSnapshot {
  legalAccepted: boolean;
  userId: string | null;
  deviceId: string | null;
  hasSession: boolean;
}

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

export function canAccess(snapshot: OnboardingSnapshot, tier: RouteTier): boolean {
  if (tier === 'public') return true;
  if (tier === 'legal_required') return snapshot.legalAccepted;
  return snapshot.hasSession;
}

export function decideSplashAction(snapshot: OnboardingSnapshot): SplashAction {
  if (!snapshot.legalAccepted) return '/legal-acceptance';
  if (!snapshot.hasSession) return '/phone-entry';
  return '/(tabs)';
}
