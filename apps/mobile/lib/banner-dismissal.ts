import * as SecureStore from 'expo-secure-store';

const KEY_PREFIX = 'onb.banner_dismissed.';
const memoryCache = new Set<string>();
let isInitialized = false;

export async function initBannerDismissals(): Promise<void> {
  if (isInitialized) return;
  // Initialize from SecureStore
  const permissionIds = ['contacts', 'notifications', 'microphone', 'camera', 'photos-files'];
  for (const id of permissionIds) {
    try {
      const val = await SecureStore.getItemAsync(`${KEY_PREFIX}${id}`);
      if (val === 'true') {
        memoryCache.add(id);
      }
    } catch (e) {
      // Fallback ignore
    }
  }
  isInitialized = true;
}

export function isBannerDismissed(permissionId: string): boolean {
  return memoryCache.has(permissionId);
}

export async function dismissBanner(permissionId: string): Promise<void> {
  memoryCache.add(permissionId);
  try {
    await SecureStore.setItemAsync(`${KEY_PREFIX}${permissionId}`, 'true');
  } catch (e) {
    // Ignore error
  }
}

export async function resetBannerDismissals(): Promise<void> {
  memoryCache.clear();
  const permissionIds = ['contacts', 'notifications', 'microphone', 'camera', 'photos-files'];
  for (const id of permissionIds) {
    try {
      await SecureStore.deleteItemAsync(`${KEY_PREFIX}${id}`);
    } catch (e) {
      // Ignore error
    }
  }
}
