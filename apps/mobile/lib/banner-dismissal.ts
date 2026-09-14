// lib/banner-dismissal.ts
//
// BANNER-SESSION — Session-scoped dismissal for denial banners.
//
// Once a banner is dismissed it does NOT reappear for the rest of the JS
// session (screen unmounts, modal reopens, etc.). The store is deliberately
// NOT backed by SecureStore/AsyncStorage: it lives in module memory only, so
// it resets naturally on app restart (a fresh JS context). This matches the
// session-scoped rule for every denial banner in this epic.

const dismissedKeys = new Set<string>();

export function isBannerDismissed(key: string): boolean {
  return dismissedKeys.has(key);
}

export function dismissBanner(key: string): void {
  dismissedKeys.add(key);
}