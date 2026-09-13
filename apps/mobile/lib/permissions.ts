// lib/permissions.ts
//
// PERM — Contextual, production-grade permission orchestration.
//
// Each permission is requested independently at the moment it is needed:
//
//   CORE SETUP (post-profile, before Chat List):
//     Notifications → explains benefit → native dialog → push registration
//     Contacts → explains purpose → native dialog → sync on grant
//
//   FEATURE-LEVEL (on demand, after reaching Chat List):
//     Microphone → only when user tries to record a voice note
//     Camera → only when user opens camera feature
//     Photos/Files → only when user tries to attach media
//
// Rules:
//   - Never request a permission that is already granted.
//   - Never repeatedly trigger native dialogs due to re-renders.
//   - Permission denial must never block core messaging.
//   - Each request is idempotent and intentional.
//   - Raw phone numbers never leave the device.

import * as Contacts from 'expo-contacts';
import * as MediaLibrary from 'expo-media-library';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import { Camera } from 'expo-camera';

import {
  syncContactsFromDevice,
  ContactSyncError,
  type ContactSyncOutcome,
} from '@/lib/contact-sync';
import {
  registerPushOnGrant,
  IS_EXPO_GO,
  type PushRegistration,
} from '@/lib/push';

// ── Types ──────────────────────────────────────────────────────────────────

export type PermissionKey =
  | 'contacts'
  | 'notifications'
  | 'microphone'
  | 'camera'
  | 'photos';

export type PermissionState = 'unknown' | 'granted' | 'denied' | 'unavailable';

export type ContactsPermissionResult = {
  status: string;
  granted: boolean;
  contactSync?: ContactSyncOutcome;
};

export type NotificationsPermissionResult = {
  status: string;
  granted: boolean;
  push?: PushRegistration;
};

// ── Contacts Permission (post-profile) ─────────────────────────────────────

/**
 * Request ONLY the Contacts permission. Intended to be called after profile
 * setup and before entering the Chat List. If granted, the contact
 * synchronization begins automatically (PERM-3). Never throws — failures are
 * carried back as structured results.
 */
export async function requestContactsPermission(): Promise<ContactsPermissionResult> {
  let status = 'error';
  let granted = false;

  try {
    const res = await Contacts.requestPermissionsAsync();
    status = res.status;
    const s = res.status as string;
    granted = res.granted ?? (s === 'granted' || s === 'limited');
  } catch {
    status = 'error';
    granted = false;
  }

  const result: ContactsPermissionResult = { status, granted };

  if (granted) {
    try {
      result.contactSync = await syncContactsFromDevice();
    } catch (e) {
      result.contactSync =
        e instanceof ContactSyncError
          ? e.toOutcome()
          : {
              status: 'failed',
              message: e instanceof Error ? e.message : 'Contact sync failed',
              contactsRead: 0,
              validNumbers: 0,
              acceptedHashes: 0,
              batchesSent: 0,
            };
    }
  }

  return result;
}

/**
 * Check the current Contacts permission state without prompting.
 * Returns 'granted', 'denied', 'unavailable', or 'unknown'.
 */
export async function checkContactsState(): Promise<PermissionState> {
  try {
    const { status } = await Contacts.getPermissionsAsync();
    const s = status as string;
    if (s === 'granted' || s === 'limited') return 'granted';
    if (s === 'denied') return 'denied';
    if (s === 'undetermined') return 'unknown';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

// ── Notifications Permission (after reaching Chat List) ────────────────────

/**
 * Request ONLY the Notifications permission. Intended to be called right after
 * profile setup, before the Chat List (see app/notifications-info.tsx).
 * Includes push-token registration when granted. Never throws.
 */
export async function requestNotificationsPermission(): Promise<NotificationsPermissionResult> {
  let status = 'error';
  let granted = false;
  let push: PushRegistration | undefined;

  try {
    if (IS_EXPO_GO) {
      status = 'unavailable';
      granted = false;
      return { status, granted };
    }
    const Notifications = await import('expo-notifications');
    const res = await Notifications.requestPermissionsAsync();
    status = res.status;
    granted = !!res.granted || res.status === 'granted';
    if (granted) {
      push = await registerPushOnGrant();
    }
  } catch {
    status = 'error';
    granted = false;
  }

  return { status, granted, push };
}

/**
 * Check the current Notifications permission state without prompting.
 */
export async function checkNotificationsState(): Promise<PermissionState> {
  if (IS_EXPO_GO) return 'unavailable';
  try {
    const Notifications = await import('expo-notifications');
    const { status } = await Notifications.getPermissionsAsync();
    if (status === 'granted') return 'granted';
    if (status === 'denied') return 'denied';
    if (status === 'undetermined') return 'unknown';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

// ── Microphone Permission (feature-level, on voice-note press) ─────────────

/**
 * Request ONLY the Microphone permission. Intended to be called when the user
 * attempts to record a voice note — never during onboarding.
 */
export async function requestMicrophonePermission(): Promise<{
  status: string;
  granted: boolean;
}> {
  try {
    const res = await requestRecordingPermissionsAsync();
    return {
      status: res.status,
      granted: res.granted ?? (res.status === 'granted'),
    };
  } catch {
    return { status: 'error', granted: false };
  }
}

/**
 * Check the current Microphone permission state without prompting.
 */
export async function checkMicrophoneState(): Promise<PermissionState> {
  try {
    const { status } = await (await import('expo-audio')).getRecordingPermissionsAsync();
    if (status === 'granted') return 'granted';
    if (status === 'denied') return 'denied';
    if (status === 'undetermined') return 'unknown';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

// ── Camera Permission (feature-level, on camera tap) ───────────────────────

/**
 * Request ONLY the Camera permission. Intended to be called when the user
 * explicitly opens a camera-dependent feature — never during onboarding.
 * Camera and Photos/Files remain independent permission states.
 */
export async function requestCameraPermission(): Promise<{
  status: string;
  granted: boolean;
}> {
  try {
    const res = await Camera.requestCameraPermissionsAsync();
    return {
      status: res.status,
      granted: res.granted ?? (res.status === 'granted'),
    };
  } catch {
    return { status: 'error', granted: false };
  }
}

/**
 * Check the current Camera permission state without prompting.
 */
export async function checkCameraState(): Promise<PermissionState> {
  try {
    const { status } = await Camera.getCameraPermissionsAsync();
    if (status === 'granted') return 'granted';
    if (status === 'denied') return 'denied';
    if (status === 'undetermined') return 'unknown';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

// ── Photos/Files Permission (feature-level, on attachment tap) ─────────────

/**
 * Request ONLY the Photos/Files permission. Intended to be called when the
 * user explicitly attempts to select/upload media or files — never during
 * onboarding. Camera and Photos/Files remain independent.
 */
export async function requestPhotosPermission(): Promise<{
  status: string;
  granted: boolean;
}> {
  try {
    const res = await MediaLibrary.requestPermissionsAsync();
    const s = res.status as string;
    return {
      status: res.status,
      granted:
        res.granted ||
        s === 'granted' ||
        (res.accessPrivileges ?? undefined) === 'limited',
    };
  } catch {
    return { status: 'error', granted: false };
  }
}

/**
 * Check the current Photos/Files permission state without prompting.
 * iOS `limited` photo access (via `accessPrivileges`) is treated as usable
 * ('granted') — the app can select from the user's chosen photos, so the
 * gallery must not be blocked.
 */
export async function checkPhotosState(): Promise<PermissionState> {
  try {
    const { status, accessPrivileges } = await MediaLibrary.getPermissionsAsync();
    const s = status as string;
    if (s === 'granted' || s === 'limited' || accessPrivileges === 'limited') return 'granted';
    if (s === 'denied') return 'denied';
    if (s === 'undetermined') return 'unknown';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

// ── Permission helpers complete (contacts, notifications, microphone, camera, photos) ──

// ── Feature-level gate (three-state model) ───────────────────────────────
// Pure, Node-verifiable state logic lives in ./permission-state; re-export it
// here so feature entry points can rely on the single permission API surface.
export {
  classifyFeatureGate,
  decideAttachAction,
  canOpenFeature,
  type FeatureGate,
  type AttachAction,
} from './permission-state';
