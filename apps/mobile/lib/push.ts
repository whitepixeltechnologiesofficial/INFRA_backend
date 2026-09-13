// lib/push.ts
//
// PUSH — What happens the moment the Notifications OS permission is decided
// (Scenario 3.4/3.5). It is requested contextually after the user reaches the
// Chat List (see lib/permissions.ts `requestNotificationsPermission`); the
// outcome branches on what the OS returns:
//
//   GRANTED: we register this device's push token with the push service so
//     the server can alert this device — including when the app is
//     backgrounded.
//   DENIED:  no push can ever fire — we store NO device token, so the push
//     service has nothing to deliver to. In-app unread badges are wholly
//     independent of this path and keep working live while the app is open
//     (lib/unread.ts). Denial must never silently hide an in-app unread the
//     UI is able to show.
//
// - `configurePushNotifications` (called once at app boot) installs the
//   notification handler — without it expo-notifications presents nothing.
// - `registerPushOnGrant` is kicked off by lib/permissions.ts as soon as the
//   OS returns "granted" and its outcome rides along on the permission result.
//   On denial it returns `not_granted` and no token is ever stored.
// - `simulateIncomingPush` is the manual GRANT-path VERIFY knob: with the app
//   backgrounded it schedules a local notification to prove the grant path's
//   alert pipeline fires.
// NOTE: `expo-notifications` is NOT imported statically here. On SDK 53+ the
// push-token auto-registration side effect (`addPushTokenListener`) fires at
// module-import time and throws inside Expo Go (remote push was removed there),
// which crashes the app on launch. So we load it lazily with dynamic `import()`
// only when a function actually needs it, and we skip entirely inside Expo Go.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import type { NotificationChannelInput, NotificationContentInput } from 'expo-notifications';

import { MOCK_PUSH_TOKEN, mockPushDebug, pushApi } from '@/api/mockPushApi';

// True when running in the Expo Go client. Remote push is unavailable there
// (SDK 53+) — any expo-notifications push API would throw, so we never touch it.
export const IS_EXPO_GO =
  Constants.appOwnership === 'expo' ||
  // expo-constants >= SDK 5x exposes executionEnvironment instead.
  (Constants as { executionEnvironment?: string }).executionEnvironment === 'storeClient';

const PUSH_TOKEN_STORE_KEY = 'onb.pushToken';

// Mock mode (default true): the app runs without a backend, so we never fetch a
// real OS push token or POST it. Throw this OFF (`EXPO_PUBLIC_USE_MOCK=false`)
// only once APNs/FCM credentials + the backend push registry are live.
const USE_MOCK = process.env.EXPO_PUBLIC_USE_MOCK !== 'false';

// The Android 8+ channel all alerts go through. Must exist with high importance
// or backgrounded notifications silently do NOT show on Android.
export const ANDROID_CHANNEL_ID = 'messages';

export type PushRegistration =
  | { status: 'registered'; token: string }
  | { status: 'not_granted' }
  | { status: 'failed'; message: string };

let handlerConfigured = false;
let channelConfigured = false;

/**
 * Install expo-notifications' handler so incoming pushes are presented as
 * alerts/banners with sound. Required for the "alerts fire when backgrounded"
 * guarantee — call once at app boot, idempotent. On Android this also ensures
 * the notification channel exists (high importance), without which backgrounded
 * alerts would be swallowed.
 */
export function configurePushNotifications(): void {
  if (IS_EXPO_GO) return;
  if (!handlerConfigured) {
    void (async () => {
      try {
        const Notifications = await import('expo-notifications');
        Notifications.setNotificationHandler({
          handleNotification: async () => ({
            shouldShowAlert: true,
            shouldShowBanner: true,
            shouldShowList: true,
            shouldPlaySound: true,
            shouldSetBadge: true,
          }),
        });
        handlerConfigured = true;
      } catch {
        // Native module unavailable on this platform — record and continue.
      }
    })();
  }

  void configureAndroidChannel();
}

/**
 * Android 8+ needs a NotificationChannel before alerts will display when the
 * app is backgrounded. Creates/updates `messages` at HIGH importance (heads-up
 * alerts + sound). Idempotent, no-op on iOS. Fails silently on devices without
 * the native module.
 */
export async function configureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android' || IS_EXPO_GO || channelConfigured) return;

  try {
    const Notifications = await import('expo-notifications');
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name: 'Messages',
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: '#3FC6B8',
      sound: 'default',
      vibrate: true,
      enableVibrate: true,
    } as NotificationChannelInput);
    channelConfigured = true;
  } catch {
    // OS below 8.0 or native module unavailable — Android <8 ignores channels.
  }
}

/**
 * Register this device with the push service. Assumes the OS dialog already
 * returned "granted"; if it did not (i.e. it was denied), reports not_granted
 * and stores NO token — so no push can ever fire for this device. Never throws
 * — failures are carried back as a structured outcome so callers can decide
 * how loud to be.
 *
 * In mock mode (default) a stable, Expo-token-shaped MOCK_PUSH_TOKEN is
 * registered so the flow can be exercised end to end with no push credentials.
 * With mock mode off (APNs/FCM + backend push registry live) a real OS token is
 * fetched via `getExpoPushTokenAsync` and registered with the backend so pushes
 * can reach this device on both platforms.
 */
export async function registerPushOnGrant(): Promise<PushRegistration> {
  try {
    if (IS_EXPO_GO) {
      // Remote push is unavailable in Expo Go (SDK 53+) — report a controlled
      // failure instead of letting expo-notifications throw during import.
      return { status: 'failed', message: 'Push is unavailable in Expo Go. Use a development build.' };
    }

    const Notifications = await import('expo-notifications');
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) {
      return { status: 'not_granted' };
    }

    if (USE_MOCK) {
      const token = MOCK_PUSH_TOKEN;
      await pushApi.registerToken(token);
      await SecureStore.setItemAsync(PUSH_TOKEN_STORE_KEY, token);
      return { status: 'registered', token };
    }

    // Real push: get the OS-issued APNs/FCM token and register it with the
    // backend push registry so it can be delivered to on both platforms.
    const data = await Notifications.getExpoPushTokenAsync();
    const token = data.data;
    await pushApi.registerToken(token);
    await SecureStore.setItemAsync(PUSH_TOKEN_STORE_KEY, token);
    return { status: 'registered', token };
  } catch (e) {
    return {
      status: 'failed',
      message: e instanceof Error ? e.message : 'Push registration failed',
    };
  }
}

export type SimulatedPushResult =
  | { delivered: boolean; scheduledId?: string }
  | { delivered: boolean; message: string };

/**
 * Manual VERIFY knob for the grant path: simulates an incoming push from the
 * server to this registered device by scheduling a local notification moments
 * out. Background the app before it fires to confirm the OS presents the alert
 * (Scenario 3.4/3.5). Requires a registered token — throws PUSH_NOT_REGISTERED
 * otherwise, mirroring the "no registration, no delivery" server rule.
 */
export async function simulateIncomingPush(): Promise<SimulatedPushResult> {
  const token = mockPushDebug.registeredToken();
  if (!token) {
    throw new Error('PUSH_NOT_REGISTERED');
  }

  try {
    if (IS_EXPO_GO) {
      throw new Error('PUSH_NOT_REGISTERED');
    }

    const Notifications = await import('expo-notifications');
    const scheduledId = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'ONB',
        body: 'New message from your test push.',
        data: { kind: 'mock-push', token },
        sound: 'default',
        channelId: ANDROID_CHANNEL_ID,
      } as NotificationContentInput,
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 2 },
    });
    return { delivered: true, scheduledId };
  } catch (e) {
    return {
      delivered: false,
      message: e instanceof Error ? e.message : 'Failed to schedule push',
    };
  }
}