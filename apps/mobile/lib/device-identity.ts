// lib/device-identity.ts
//
// ONB-1.7 — stable device identity.
//
// A physical device must retain the same logical device ID across normal
// login/session operations. Logging in again on the same device must NOT mint
// a brand-new identity (which would orphan the session registry and make the
// old-device cutoff unobservable). The ID is generated once and persisted in
// SecureStore (`deviceId` key), reused on every subsequent login.
//
// The ID is intentionally NOT derived from the timestamp alone, and never from
// the phone number. No extra device data is collected.

export const DEVICE_ID_STORAGE_KEY = 'deviceId';

/**
 * Generate a unique-ish device identifier from two independent random passes
 * (no timestamp, no phone number). Enough entropy for a logical device ID.
 */
export function generateDeviceId(): string {
  const rand = () => Math.random().toString(36).slice(2);
  return `device_${rand()}${rand()}`.slice(0, 24);
}

export type SecureStorageAdapter = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
};

/**
 * Pure, testable get-or-create core. Returns the persisted device ID, creating
 * and persisting one on first use. The `created` flag distinguishes first
 * generation from an existing identity.
 */
export async function getOrCreateDeviceIdWithStore(
  store: SecureStorageAdapter,
  key: string = DEVICE_ID_STORAGE_KEY,
): Promise<{ deviceId: string; created: boolean }> {
  const existing = await store.getItemAsync(key);
  if (existing) return { deviceId: existing, created: false };
  const fresh = generateDeviceId();
  await store.setItemAsync(key, fresh);
  return { deviceId: fresh, created: true };
}

let secureStoreRef: SecureStorageAdapter | null = null;

/**
 * Lazily resolved so headless Node harnesses (which import this module but
 * have no expo-secure-store runtime) only ever touch SecureStore when the app
 * actually calls getOrCreateDeviceId.
 */
function getSecureStore(): SecureStorageAdapter {
  if (!secureStoreRef) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    secureStoreRef = require('expo-secure-store') as SecureStorageAdapter;
  }
  return secureStoreRef;
}

/** App entry point — returns the stable persisted device ID. */
export async function getOrCreateDeviceId(): Promise<string> {
  const { deviceId } = await getOrCreateDeviceIdWithStore(getSecureStore());
  return deviceId;
}