// lib/permissions.ts
//
// One check + one request per permission. Every request is a SINGLE native
// permission call (never a "request multiple" helper) so PERM-2.2 can chain
// them one by one. Checks never prompt.
//
// The OS is the source of truth: these are re-read on mount and on every
// foreground transition (hooks/use-permission-state.ts), never cached.

import * as Contacts from 'expo-contacts';
import * as ImagePicker from 'expo-image-picker';
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';
import type { PermissionKey, StepOutcome } from './permission-sequence';
import { ensureNotificationChannel } from './push';

export type { PermissionKey } from './permission-sequence';

/** unknown = the OS can still ask (undetermined). */
export type PermissionState = 'unknown' | 'granted' | 'denied' | 'unavailable';

type RawPermission = {
  status?: string;
  granted?: boolean;
  canAskAgain?: boolean;
  accessPrivileges?: string;
};

export function classifyPermission(res: RawPermission | null | undefined): PermissionState {
  if (!res) return 'unavailable';
  if (res.granted || res.status === 'granted') return 'granted';
  if (res.accessPrivileges === 'limited' || res.accessPrivileges === 'all') return 'granted';
  if (res.status === 'undetermined') return 'unknown';
  return 'denied';
}

export function toStepOutcome(state: PermissionState): StepOutcome {
  if (state === 'granted') return 'granted';
  if (state === 'unavailable') return 'unavailable';
  return 'denied';
}

async function safe(fn: () => Promise<RawPermission>): Promise<PermissionState> {
  try {
    return classifyPermission(await fn());
  } catch {
    return 'unavailable';
  }
}

async function notificationsModule() {
  return import('expo-notifications');
}

const CHECKS: Record<PermissionKey, () => Promise<PermissionState>> = {
  contacts: () => safe(() => Contacts.getPermissionsAsync()),
  notifications: () => safe(async () => (await notificationsModule()).getPermissionsAsync()),
  microphone: () => safe(() => getRecordingPermissionsAsync()),
  camera: () => safe(() => ImagePicker.getCameraPermissionsAsync()),
  photos: () => safe(() => ImagePicker.getMediaLibraryPermissionsAsync()),
};

const REQUESTS: Record<PermissionKey, () => Promise<PermissionState>> = {
  contacts: () => safe(() => Contacts.requestPermissionsAsync()),
  notifications: () =>
    safe(async () => {
      // Android 13+ only shows the dialog once a channel exists.
      await ensureNotificationChannel();
      return (await notificationsModule()).requestPermissionsAsync();
    }),
  microphone: () => safe(() => requestRecordingPermissionsAsync()),
  camera: () => safe(() => ImagePicker.requestCameraPermissionsAsync()),
  photos: () => safe(() => ImagePicker.requestMediaLibraryPermissionsAsync()),
};

export const checkPermission = (key: PermissionKey) => CHECKS[key]();
export const requestPermission = (key: PermissionKey) => REQUESTS[key]();

export const checkContactsState = () => checkPermission('contacts');
export const checkNotificationsState = () => checkPermission('notifications');
export const checkMicrophoneState = () => checkPermission('microphone');
export const checkCameraState = () => checkPermission('camera');
export const checkPhotosState = () => checkPermission('photos');

export const requestContactsPermission = () => requestPermission('contacts');
export const requestNotificationsPermission = () => requestPermission('notifications');
export const requestMicrophonePermission = () => requestPermission('microphone');
export const requestCameraPermission = () => requestPermission('camera');
export const requestPhotosPermission = () => requestPermission('photos');
