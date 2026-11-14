// lib/push.ts
//
// PERM-2.5 — push alerts while the app is backgrounded.
//
//  - ensureNotificationChannel(): Android 8+ needs a HIGH-importance channel
//    for a heads-up alert, and Android 13+ will not even show the permission
//    dialog until a channel exists. Idempotent.
//  - configureNotifications(): installs the foreground handler at boot.
//  - registerPushToken(): on grant, fetch this device's Expo push token
//    (backed by FCM/APNs) and bind it on the backend. The backend then sends
//    an alert for any message relayed while this device has no live socket.
//
// Every function here is best-effort and never throws: notifications are not
// allowed to break onboarding or messaging.

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { pushApi } from '@/api/pushApi';

export const MESSAGES_CHANNEL_ID = 'messages';

let channelReady: Promise<void> | null = null;
let handlerInstalled = false;

async function notifications() {
  return import('expo-notifications');
}

export function ensureNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  if (!channelReady) {
    channelReady = (async () => {
      try {
        const N = await notifications();
        await N.setNotificationChannelAsync(MESSAGES_CHANNEL_ID, {
          name: 'Messages',
          importance: N.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#3FC6B8',
        });
      } catch {
        channelReady = null;
      }
    })();
  }
  return channelReady ?? Promise.resolve();
}

export async function configureNotifications(): Promise<void> {
  if (handlerInstalled || Platform.OS === 'web') return;
  handlerInstalled = true;
  try {
    const N = await notifications();
    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });
  } catch {
    handlerInstalled = false;
  }
  await ensureNotificationChannel();
}

export type PushRegistration =
  | { status: 'registered'; token: string }
  | { status: 'not_granted' }
  | { status: 'failed'; reason: string };

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
}

export async function registerPushToken(): Promise<PushRegistration> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return { status: 'failed', reason: 'UNSUPPORTED_PLATFORM' };
  try {
    const N = await notifications();
    const { status } = await N.getPermissionsAsync();
    if (status !== 'granted') return { status: 'not_granted' };
    await ensureNotificationChannel();
    const id = projectId();
    const { data: token } = await N.getExpoPushTokenAsync(id ? { projectId: id } : undefined);
    await pushApi.register(token, Platform.OS);
    return { status: 'registered', token };
  } catch (e) {
    return { status: 'failed', reason: e instanceof Error ? e.message : 'PUSH_REGISTRATION_FAILED' };
  }
}
