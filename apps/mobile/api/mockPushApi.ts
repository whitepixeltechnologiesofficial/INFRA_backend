// api/mockPushApi.ts
//
// PUSH — Mock implementation of the push-token registration endpoint (Scenario
// 3.4/3.5 grant path, Tech Arch §14.x). Mirrors the future live backend's
// device-token registry in-memory so the app runs without a backend process.
//
// Contract:
//   - The client registers its device push token when the Notifications OS
//     permission is granted (PERM-2.2, 2nd in the fixed sequence).
//   - The endpoint accepts ONLY an Expo push-token-shaped string
//     (`ExponentPushToken[...]`). Any malformed entry is rejected outright —
//     the same spirit as the contact-hash endpoint rejecting raw numbers.
//   - Once a token is registered the server can deliver pushes to this device;
//     when the app is backgrounded the OS presents them as alerts.
//
// Screens call `pushApi` exactly like the future live endpoint;
// `mockPushDebug` holds verification helpers for manual testing.

// Token the mock platform issues to this device. On a real build this would be
// expo-notifications' `getExpoPushTokenAsync()` result (APNs/FCM-backed); with
// the backend disabled we ship a stable mock token so registration + delivery
// can be exercised end to end without push credentials.
export const MOCK_PUSH_TOKEN = 'ExponentPushToken[onb-mock-1a2b3c4d5e6f]';

const TOKEN_SHAPE = /^ExponentPushToken\[[A-Za-z0-9\-_~]{6,}\]$/;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// In-memory "push_devices" table (device token per install, simulated).
let registeredDeviceToken: string | null = null;

export type PushRegisterResult = {
  accepted: boolean;
  token: string;
};

export const pushApi = {
  /**
   * Register this device's push token. Rejects a malformed token (any string
   * that does not match Expo's token shape) — a raw/non-token value can never
   * be stored. Re-registering the same token is idempotent.
   */
  async registerToken(token: string): Promise<PushRegisterResult> {
    await delay(50);

    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) {
      throw Object.assign(new Error('INVALID_TOKEN'), { status: 400 });
    }

    registeredDeviceToken = token;

    return { accepted: true, token };
  },
};

// ── Verification helpers (manual tests only; screens never use these) ──
export const mockPushDebug = {
  isRegistered(): boolean {
    return registeredDeviceToken !== null;
  },

  registeredToken(): string | null {
    return registeredDeviceToken;
  },

  reset(): void {
    registeredDeviceToken = null;
  },
};