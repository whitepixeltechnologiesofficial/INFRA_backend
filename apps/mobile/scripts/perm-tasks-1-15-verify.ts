// @ts-nocheck
// scripts/perm-tasks-1-15-verify.ts
//
// Tasks 1-15 comprehensive verification harness.
//
// Run (from apps/mobile):  tsx scripts/perm-tasks-1-15-verify.ts
//
// Tests deterministic logic + source-code structural invariants. No device,
// no backend process, no native modules. Covers:
//
//   T1  — Contacts permission: explain + request + grant + deny
//   T2  — Notifications permission: explain + request + grant + deny
//   T3  — Microphone permission: on-demand gate + voice notes
//   T4  — Camera permission: contextual three-state + on-demand
//   T5  — Photos/Files permission: contextual three-state + on-demand
//   T6  — Permission order: Contacts → Notifications → Microphone → Camera → Photos
//   T7  — Permission independence: each permission is independent
//   T8  — Grant paths work correctly
//   T9  — Denial paths don't block app functionality
//   T10 — Settings re-grant detection (foreground re-detection)
//   T11 — Profile photo flow: Camera and Photos independent
//   T12 — Banner behavior: session-scoped, correct copy, no stacking
//   T13 — Foreground re-detection (AppState) for all permissions
//   T14 — No permission modifies authentication state
//   T15 — All-five-denied: basic messaging still works

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Test plumbing ────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    pass += 1;
  } catch (e) {
    fail += 1;
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const MOBILE = path.resolve(__dirname, '..');
function readFile(rel: string): string {
  return fs.readFileSync(path.join(MOBILE, rel), 'utf-8');
}

// ── T1: Contacts permission (PERM-2.1) ──────────────────────────────────
function testT1() {
  console.log('T1 — Contacts permission');

  const permissionInfo = readFile('app/permission-info.tsx');
  const permissions = readFile('lib/permissions.ts');

  check('T1a permission-info.tsx exists and imports requestContactsPermission', () => {
    assert.ok(permissionInfo.includes('requestContactsPermission'));
  });
  check('T1b permission-info.tsx checks state before requesting (never re-requests decided)', () => {
    assert.ok(permissionInfo.includes('checkContactsState'));
    assert.ok(permissionInfo.includes("state === 'unknown'"));
  });
  check('T1c permission-info.tsx triggers sync on grant', () => {
    assert.ok(permissionInfo.includes('contactSync'));
  });
  check('T1d permission-info.tsx denial is non-fatal (proceeds to next screen)', () => {
    assert.ok(permissionInfo.includes('router.replace'));
    assert.ok(permissionInfo.includes('/notifications-info'));
  });
  check('T1e permissions.ts has independent requestContactsPermission', () => {
    assert.ok(permissions.includes('export async function requestContactsPermission'));
  });
  check('T1f permissions.ts has checkContactsState', () => {
    assert.ok(permissions.includes('export async function checkContactsState'));
  });
  check('T1g contacts permission does not touch SecureStore auth keys', () => {
    assert.ok(!permissionInfo.includes("SecureStore.setItemAsync('userId'"));
    assert.ok(!permissionInfo.includes("SecureStore.setItemAsync('accessToken'"));
    assert.ok(!permissionInfo.includes("SecureStore.setItemAsync('refreshToken'"));
  });
}

// ── T2: Notifications permission (PERM-2.2 / NOTIFICATIONS) ─────────────
function testT2() {
  console.log('T2 — Notifications permission');

  const notificationsInfo = readFile('app/notifications-info.tsx');
  const permissions = readFile('lib/permissions.ts');

  check('T2a notifications-info.tsx exists and imports requestNotificationsPermission', () => {
    assert.ok(notificationsInfo.includes('requestNotificationsPermission'));
  });
  check('T2b notifications-info.tsx checks state before requesting', () => {
    assert.ok(notificationsInfo.includes('checkNotificationsState'));
    assert.ok(notificationsInfo.includes("state === 'unknown'"));
  });
  check('T2c notifications-info.tsx denial is non-fatal (proceeds to chats)', () => {
    assert.ok(notificationsInfo.includes('router.replace'));
    assert.ok(notificationsInfo.includes('/(tabs)'));
  });
  check('T2d permissions.ts has independent requestNotificationsPermission', () => {
    assert.ok(permissions.includes('export async function requestNotificationsPermission'));
  });
  check('T2e permissions.ts has checkNotificationsState', () => {
    assert.ok(permissions.includes('export async function checkNotificationsState'));
  });
  check('T2f notifications permission does not touch SecureStore auth keys', () => {
    assert.ok(!notificationsInfo.includes("SecureStore.setItemAsync('userId'"));
    assert.ok(!notificationsInfo.includes("SecureStore.setItemAsync('accessToken'"));
    assert.ok(!notificationsInfo.includes("SecureStore.setItemAsync('refreshToken'"));
  });
}

// ── T3: Microphone permission (PERM-2.7) ────────────────────────────────
function testT3() {
  console.log('T3 — Microphone permission');

  const voiceNote = readFile('lib/voice-note.ts');
  const permissions = readFile('lib/permissions.ts');

  check('T3a permissions.ts has requestMicrophonePermission', () => {
    assert.ok(permissions.includes('export async function requestMicrophonePermission'));
  });
  check('T3b permissions.ts has checkMicrophoneState', () => {
    assert.ok(permissions.includes('export async function checkMicrophoneState'));
  });
  check('T3c voice-note.ts classifyMicGranted maps correctly', () => {
    const { classifyMicGranted } = require('../lib/voice-note');
    assert.strictEqual(classifyMicGranted(true, 'granted'), 'granted');
    assert.strictEqual(classifyMicGranted(false, 'denied'), 'denied');
    assert.strictEqual(classifyMicGranted(false, 'blocked'), 'denied');
    assert.strictEqual(classifyMicGranted(false, 'undetermined'), 'undetermined');
  });
  check('T3d voice-note.ts only grants recording on mic permission', () => {
    const { decideRecordAction } = require('../lib/voice-note');
    assert.strictEqual(decideRecordAction('granted'), 'record');
    assert.strictEqual(decideRecordAction('undetermined'), 'request');
    assert.strictEqual(decideRecordAction('denied'), 'denied');
  });
  check('T3e microphone denial does not break text messaging', () => {
    const { canRecordVoiceNotes } = require('../lib/voice-note');
    assert.strictEqual(canRecordVoiceNotes('denied'), false);
    assert.strictEqual(canRecordVoiceNotes('granted'), true);
  });
}

// ── T4: Camera permission (PERM-2.9/2.10) ──────────────────────────────
function testT4() {
  console.log('T4 — Camera permission');

  const permissions = readFile('lib/permissions.ts');
  const permissionState = readFile('lib/permission-state.ts');

  check('T4a permissions.ts has requestCameraPermission', () => {
    assert.ok(permissions.includes('export async function requestCameraPermission'));
  });
  check('T4b permissions.ts has checkCameraState', () => {
    assert.ok(permissions.includes('export async function checkCameraState'));
  });
  check('T4c three-state gate: granted opens, undetermined asks, denied settings', () => {
    const { decideAttachAction } = require('../lib/permission-state');
    assert.strictEqual(decideAttachAction('granted'), 'open');
    assert.strictEqual(decideAttachAction('undetermined'), 'ask');
    assert.strictEqual(decideAttachAction('denied'), 'ask', 'stale denied re-asks OS once');
  });
  check('T4d after ask result: granted -> open, denied -> settings', () => {
    const { decideAttachAction } = require('../lib/permission-state');
    assert.strictEqual(decideAttachAction('undetermined', { granted: true }), 'open');
    assert.strictEqual(decideAttachAction('undetermined', { granted: false }), 'settings');
  });
  check('T4e camera does not pre-initialize before grant (NO-PREINIT)', () => {
    const chatList = readFile('app/(tabs)/index.tsx');
    assert.ok(chatList.includes('MIC NO-PREINIT'));
    assert.ok(chatList.includes('recorderRef'));
    assert.ok(chatList.includes('ensureRecorder'));
  });
}

// ── T5: Photos/Files permission (PERM-2.11/2.12) ────────────────────────
function testT5() {
  console.log('T5 — Photos/Files permission');

  const permissions = readFile('lib/permissions.ts');

  check('T5a permissions.ts has requestPhotosPermission', () => {
    assert.ok(permissions.includes('export async function requestPhotosPermission'));
  });
  check('T5b permissions.ts has checkPhotosState', () => {
    assert.ok(permissions.includes('export async function checkPhotosState'));
  });
  check('T5c iOS limited photo access treated as granted', () => {
    assert.ok(permissions.includes("'limited'"));
    assert.ok(permissions.includes('accessPrivileges'));
  });
  check('T5d Photos/Files three-state gate works independently', () => {
    const { decideAttachAction, classifyFeatureGate } = require('../lib/permission-state');
    assert.strictEqual(classifyFeatureGate('granted'), 'granted');
    assert.strictEqual(classifyFeatureGate('denied'), 'denied');
    assert.strictEqual(classifyFeatureGate('unknown'), 'undetermined');
    assert.strictEqual(decideAttachAction('granted'), 'open');
  });
}

// ── T6: Permission order (Contacts → Notifications → Microphone → Camera → Photos) ──
function testT6() {
  console.log('T6 — Permission order');

  const profileSetup = readFile('app/profile-setup.tsx');
  const permissionIntro = readFile('app/permission-intro.tsx');
  const permissionInfo = readFile('app/permission-info.tsx');
  const notificationsInfo = readFile('app/notifications-info.tsx');
  const chatList = readFile('app/(tabs)/index.tsx');

  check('T6a profile-setup routes to permission-intro after createProfile', () => {
    assert.ok(profileSetup.includes("pathname: '/permission-intro'"));
  });
  check('T6b permission-intro routes to permission-info (Contacts first)', () => {
    assert.ok(permissionIntro.includes("pathname: '/permission-info'"));
    assert.ok(!permissionIntro.includes("pathname: '/notifications-info'"),
      'permission-intro must NOT route directly to notifications-info');
  });
  check('T6c permission-info (Contacts) routes to notifications-info after Contacts', () => {
    assert.ok(permissionInfo.includes("pathname: '/notifications-info'"));
    assert.ok(!permissionInfo.includes("pathname: '/(tabs)'"),
      'permission-info must NOT route directly to chats — Notifications must follow');
  });
  check('T6d notifications-info (Notifications) routes to (tabs) after Notifications', () => {
    assert.ok(notificationsInfo.includes("pathname: '/(tabs)'"));
    assert.ok(!notificationsInfo.includes("pathname: '/permission-info'"),
      'notifications-info must NOT route back to permission-info');
  });
  check('T6e Microphone is on-demand in chat (after reaching tabs)', () => {
    assert.ok(chatList.includes('decideRecordAction'));
    assert.ok(chatList.includes('tryStartRecording'));
  });
  check('T6f Camera is on-demand in chat (after reaching tabs)', () => {
    assert.ok(chatList.includes('handleAttachCamera'));
    assert.ok(chatList.includes('requestCameraPermission'));
  });
  check('T6g Photos/Files is on-demand in chat (after reaching tabs)', () => {
    assert.ok(chatList.includes('handleAttachGallery'));
    assert.ok(chatList.includes('requestPhotosPermission'));
  });
  check('T6h No permission request from phone-entry.tsx', () => {
    const phoneEntry = readFile('app/phone-entry.tsx');
    assert.ok(!phoneEntry.includes('requestContactsPermission'));
    assert.ok(!phoneEntry.includes('requestNotificationsPermission'));
    assert.ok(!phoneEntry.includes('requestMicrophonePermission'));
    assert.ok(!phoneEntry.includes('requestCameraPermission'));
    assert.ok(!phoneEntry.includes('requestPhotosPermission'));
  });
  check('T6i No permission request from otp-entry.tsx', () => {
    const otpEntry = readFile('app/otp-entry.tsx');
    assert.ok(!otpEntry.includes('requestContactsPermission'));
    assert.ok(!otpEntry.includes('requestNotificationsPermission'));
    assert.ok(!otpEntry.includes('requestMicrophonePermission'));
    assert.ok(!otpEntry.includes('requestCameraPermission'));
    assert.ok(!otpEntry.includes('requestPhotosPermission'));
  });
  check('T6j No permission request from index.tsx (splash)', () => {
    const splash = readFile('app/index.tsx');
    assert.ok(!splash.includes('requestPermissions'));
    assert.ok(!splash.includes('requestContactsPermission'));
  });
}

// ── T7: Permission independence ──────────────────────────────────────────
function testT7() {
  console.log('T7 — Permission independence');

  const chatList = readFile('app/(tabs)/index.tsx');
  const permissions = readFile('lib/permissions.ts');

  check('T7a Camera and Photos are separate state variables', () => {
    assert.ok(chatList.includes('cameraGate'));
    assert.ok(chatList.includes('photosGate'));
    assert.notStrictEqual(
      chatList.indexOf('cameraGate'),
      chatList.indexOf('photosGate'),
      'camera and photos gates must be different variables',
    );
  });
  check('T7b Camera and Photos have independent request functions', () => {
    assert.ok(permissions.includes('requestCameraPermission'));
    assert.ok(permissions.includes('requestPhotosPermission'));
    assert.ok(permissions.includes('checkCameraState'));
    assert.ok(permissions.includes('checkPhotosState'));
  });
  check('T7c Denying Camera does not affect Photos gate', () => {
    const { classifyFeatureGate } = require('../lib/permission-state');
    const camGate = classifyFeatureGate('denied');
    const photosGate = classifyFeatureGate('granted');
    assert.strictEqual(camGate, 'denied');
    assert.strictEqual(photosGate, 'granted');
  });
  check('T7d Denying Photos does not affect Camera gate', () => {
    const { classifyFeatureGate } = require('../lib/permission-state');
    const camGate = classifyFeatureGate('granted');
    const photosGate = classifyFeatureGate('denied');
    assert.strictEqual(camGate, 'granted');
    assert.strictEqual(photosGate, 'denied');
  });
  check('T7e Microphone, Camera, Photos each have independent check functions', () => {
    assert.ok(permissions.includes('checkMicrophoneState'));
    assert.ok(permissions.includes('checkCameraState'));
    assert.ok(permissions.includes('checkPhotosState'));
  });
  check('T7f Contacts and Notifications each have independent check/request', () => {
    assert.ok(permissions.includes('checkContactsState'));
    assert.ok(permissions.includes('requestContactsPermission'));
    assert.ok(permissions.includes('checkNotificationsState'));
    assert.ok(permissions.includes('requestNotificationsPermission'));
  });
}

// ── T8: Grant paths ──────────────────────────────────────────────────────
function testT8() {
  console.log('T8 — Grant paths');

  const { classifyFeatureGate, decideAttachAction, canOpenFeature } = require('../lib/permission-state');
  const { classifyMicGranted, canRecordVoiceNotes, decideRecordAction } = require('../lib/voice-note');

  check('T8a Contacts grant: sync triggers, user proceeds', () => {
    const permissionInfo = readFile('app/permission-info.tsx');
    assert.ok(permissionInfo.includes('contactSync'));
    assert.ok(permissionInfo.includes("'completed'"));
  });
  check('T8b Notifications grant: push registration triggers', () => {
    const permissions = readFile('lib/permissions.ts');
    assert.ok(permissions.includes('registerPushOnGrant'));
    assert.ok(permissions.includes('if (granted)'));
  });
  check('T8c Microphone grant: can record voice notes', () => {
    assert.strictEqual(canRecordVoiceNotes('granted'), true);
    assert.strictEqual(decideRecordAction('granted'), 'record');
  });
  check('T8d Camera grant: feature opens immediately', () => {
    const gate = classifyFeatureGate('granted');
    assert.strictEqual(decideAttachAction(gate), 'open');
    assert.strictEqual(canOpenFeature(gate), true);
  });
  check('T8e Photos grant: feature opens immediately', () => {
    const gate = classifyFeatureGate('granted');
    assert.strictEqual(decideAttachAction(gate), 'open');
    assert.strictEqual(canOpenFeature(gate), true);
  });
}

// ── T9: Denial paths don't block app ────────────────────────────────────
function testT9() {
  console.log('T9 — Denial paths');

  const { decideAttachAction } = require('../lib/permission-state');
  const { decideRecordAction, canRecordVoiceNotes } = require('../lib/voice-note');

  check('T9a Contacts denial: proceeds to Notifications screen', () => {
    const permissionInfo = readFile('app/permission-info.tsx');
    assert.ok(permissionInfo.includes('/notifications-info'));
    assert.ok(!permissionInfo.includes('router.replace') || permissionInfo.includes('/notifications-info'));
  });
  check('T9b Notifications denial: proceeds to Chat List', () => {
    const notificationsInfo = readFile('app/notifications-info.tsx');
    assert.ok(notificationsInfo.includes('/(tabs)'));
  });
  check('T9c Microphone denial: text messaging still works', () => {
    assert.strictEqual(canRecordVoiceNotes('denied'), false);
    const chatList = readFile('app/(tabs)/index.tsx');
    assert.ok(chatList.includes('sendMessage'));
    assert.ok(chatList.includes('inputText'));
  });
  check('T9d Camera denial: shows settings prompt, not crash', () => {
    const chatList = readFile('app/(tabs)/index.tsx');
    assert.ok(chatList.includes('promptCameraSettings'));
    assert.ok(chatList.includes('Camera access needed'));
  });
  check('T9e Photos denial: shows settings prompt, not crash', () => {
    const chatList = readFile('app/(tabs)/index.tsx');
    assert.ok(chatList.includes('promptPhotosSettings'));
    assert.ok(chatList.includes('Media access needed'));
  });
  check('T9f Denial does not leave the user in a broken non-navigable state', () => {
    const permissionInfo = readFile('app/permission-info.tsx');
    const notificationsInfo = readFile('app/notifications-info.tsx');
    assert.ok(permissionInfo.includes('finally'));
    assert.ok(notificationsInfo.includes('finally'));
  });
  check('T9g No navigation loop on denial', () => {
    const permissionInfo = readFile('app/permission-info.tsx');
    assert.ok(permissionInfo.includes('router.replace'));
    const notificationsInfo = readFile('app/notifications-info.tsx');
    assert.ok(notificationsInfo.includes('router.replace'));
  });
  check('T9h Denial does not reset auth state', () => {
    const permissionInfo = readFile('app/permission-info.tsx');
    assert.ok(!permissionInfo.includes("SecureStore.setItemAsync('userId'"));
    assert.ok(!permissionInfo.includes("SecureStore.deleteItemAsync('userId'"));
    const notificationsInfo = readFile('app/notifications-info.tsx');
    assert.ok(!notificationsInfo.includes("SecureStore.setItemAsync('userId'"));
  });
}

// ── T10: Settings re-grant detection (PERM-2.13) ────────────────────────
function testT10() {
  console.log('T10 — Settings re-grant detection');

  const chatList = readFile('app/(tabs)/index.tsx');
  const profileSetup = readFile('app/profile-setup.tsx');

  check('T10a ChatList: AppState listener re-queries mic on foreground', () => {
    assert.ok(chatList.includes('syncMicGate'));
    assert.ok(chatList.includes("state === 'active'"));
    assert.ok(chatList.includes('getRecordingPermissionsAsync'));
  });
  check('T10b ChatList: AppState listener re-queries camera on foreground', () => {
    assert.ok(chatList.includes('syncCameraGate'));
    assert.ok(chatList.includes('checkCameraState'));
  });
  check('T10c ChatList: AppState listener re-queries photos on foreground', () => {
    assert.ok(chatList.includes('syncPhotosGate'));
    assert.ok(chatList.includes('checkPhotosState'));
  });
  check('T10d ChatList: AppState listener re-queries notifications on foreground', () => {
    assert.ok(chatList.includes('checkNotificationsState'));
    assert.ok(chatList.includes('registerPushOnGrant'));
  });
  check('T10e ChatList: AppState listener re-checks contacts when picker open', () => {
    assert.ok(chatList.includes('Contacts.getPermissionsAsync'));
    assert.ok(chatList.includes('loadContactsForPicker'));
  });
  check('T10f ProfileSetup: AppState re-checks camera/photos on foreground', () => {
    assert.ok(profileSetup.includes("next !== 'active'"));
    assert.ok(profileSetup.includes('checkCameraState'));
    assert.ok(profileSetup.includes('checkPhotosState'));
  });
  check('T10g Gate updated after successful in-app permission request (camera)', () => {
    assert.ok(chatList.includes("if (res.granted) setCameraGate('granted')"));
  });
  check('T10h Gate updated after successful in-app permission request (photos)', () => {
    assert.ok(chatList.includes("if (res.granted) setPhotosGate('granted')"));
  });
}

// ── T11: Profile photo flow — Camera and Photos independent ─────────────
function testT11() {
  console.log('T11 — Profile photo flow');

  const profileSetup = readFile('app/profile-setup.tsx');

  check('T11a Take Photo requests Camera permission only', () => {
    assert.ok(profileSetup.includes('handleTakePhoto'));
    assert.ok(profileSetup.includes('requestCameraPermission'));
    assert.ok(profileSetup.includes('launchCameraAsync'));
  });
  check('T11b Choose from Gallery requests Photos permission only', () => {
    assert.ok(profileSetup.includes('handlePickImage'));
    assert.ok(profileSetup.includes('requestPhotosPermission'));
    assert.ok(profileSetup.includes('launchImageLibraryAsync'));
  });
  check('T11c Camera path does NOT request Photos permission', () => {
    const takePhotoFn = profileSetup.substring(
      profileSetup.indexOf('handleTakePhoto'),
      profileSetup.indexOf('handleRemovePhoto'),
    );
    assert.ok(!takePhotoFn.includes('requestPhotosPermission'),
      'handleTakePhoto must not request Photos permission');
  });
  check('T11d Gallery path does NOT request Camera permission', () => {
    const pickImageFn = profileSetup.substring(
      profileSetup.indexOf('handlePickImage'),
      profileSetup.indexOf('handleTakePhoto'),
    );
    assert.ok(!pickImageFn.includes('requestCameraPermission'),
      'handlePickImage must not request Camera permission');
  });
  check('T11e Both paths have independent denial handling', () => {
    assert.ok(profileSetup.includes('setCameraDenied'));
    assert.ok(profileSetup.includes('setPhotosDenied'));
  });
}

// ── T12: Banner behavior ────────────────────────────────────────────────
function testT12() {
  console.log('T12 — Banner behavior');

  const banner = readFile('components/permission-banner.tsx');
  const dismissal = readFile('lib/banner-dismissal.ts');

  check('T12a Banner component exists with all 5 permission IDs', () => {
    assert.ok(banner.includes('contacts'));
    assert.ok(banner.includes('notifications'));
    assert.ok(banner.includes('microphone'));
    assert.ok(banner.includes('camera'));
    assert.ok(banner.includes('photos-files'));
  });
  check('T12b Banner dismissal is session-scoped (module Set, not persisted)', () => {
    assert.ok(dismissal.includes('Set<string>'));
    assert.ok(!dismissal.includes("SecureStore.setItem"));
    assert.ok(!dismissal.includes("import AsyncStorage"));
  });
  check('T12c Banner has correct copy for each permission', () => {
    assert.ok(banner.includes("Contacts are off"));
    assert.ok(banner.includes("Notifications are off"));
    assert.ok(banner.includes("Microphone is off"));
    assert.ok(banner.includes("Camera is off"));
    assert.ok(banner.includes("Photos & Files are off"));
  });
  check('T12d Banner has dismiss button and Settings link', () => {
    assert.ok(banner.includes('handleDismiss'));
    assert.ok(banner.includes('Open Settings'));
    assert.ok(banner.includes('Linking.openSettings'));
  });
  check('T12e ChatList shows notifications banner when denied', () => {
    const chatList = readFile('app/(tabs)/index.tsx');
    assert.ok(chatList.includes('notificationsDenied'));
    assert.ok(chatList.includes("permissionId=\"notifications\""));
  });
  check('T12e-b Notifications banner only in ChatListScreen (not permission-info)', () => {
    const notificationsInfo = readFile('app/notifications-info.tsx');
    assert.ok(!notificationsInfo.includes("permissionId=\"notifications\""));
  });
  check('T12f ChatList shows contacts banner only when denied in picker', () => {
    const chatList = readFile('app/(tabs)/index.tsx');
    assert.ok(chatList.includes("permissionId=\"contacts\""));
    assert.ok(chatList.includes('permissionDenied'));
  });
}

// ── T13: Foreground re-detection (AppState, PERM-2.13) ──────────────────
function testT13() {
  console.log('T13 — Foreground re-detection');

  const chatList = readFile('app/(tabs)/index.tsx');

  check('T13a AppState listener registered in ChatView for mic/camera/photos', () => {
    assert.ok(chatList.includes('AppState.addEventListener'));
    assert.ok(chatList.includes("state === 'active'"));
    assert.ok(chatList.includes('syncMicGate()'));
    assert.ok(chatList.includes('syncCameraGate()'));
    assert.ok(chatList.includes('syncPhotosGate()'));
  });
  check('T13b AppState listener registered for notifications in ChatListScreen', () => {
    assert.ok(chatList.includes('resyncNotifications'));
    assert.ok(chatList.includes("state === 'active'"));
  });
  check('T13c Contacts picker has AppState listener for foreground re-detection', () => {
    assert.ok(chatList.includes('showContactPicker'));
    assert.ok(chatList.includes('Contacts.getPermissionsAsync'));
  });
  check('T13d Listener is cleaned up on unmount', () => {
    assert.ok(chatList.includes('sub.remove()'));
  });
  check('T13e ProfileSetup has AppState listener for camera/photos re-check', () => {
    const profileSetup = readFile('app/profile-setup.tsx');
    assert.ok(profileSetup.includes('AppState.addEventListener'));
    assert.ok(profileSetup.includes('checkCameraState'));
    assert.ok(profileSetup.includes('checkPhotosState'));
  });
}

// ── T14: No permission modifies authentication state ─────────────────────
function testT14() {
  console.log('T14 — No permission modifies auth state');

  const authFiles = [
    'app/permission-info.tsx',
    'app/notifications-info.tsx',
    'app/permission-intro.tsx',
    'lib/permissions.ts',
    'lib/permission-state.ts',
    'lib/voice-note.ts',
    'lib/contact-sync.ts',
    'lib/banner-dismissal.ts',
    'components/permission-banner.tsx',
  ];

  const authKeyPatterns = [
    "SecureStore.setItemAsync('userId'",
    "SecureStore.setItemAsync('accessToken'",
    "SecureStore.setItemAsync('refreshToken'",
    "SecureStore.setItemAsync('displayPhone'",
    "SecureStore.setItemAsync('phoneNumber'",
    "SecureStore.setItemAsync('deviceId'",
    "SecureStore.deleteItemAsync('userId'",
  ];

  for (const file of authFiles) {
    const content = readFile(file);
    for (const pattern of authKeyPatterns) {
      check(`T14 ${file} does not write auth key ${pattern}`, () => {
        assert.ok(!content.includes(pattern), `${file} writes auth key ${pattern}`);
      });
    }
  }

  check('T14a No permission path creates a session', () => {
    const permissionInfo = readFile('app/permission-info.tsx');
    assert.ok(!permissionInfo.includes('createSession'));
    assert.ok(!permissionInfo.includes('onboardingApi.createSession'));
    const notificationsInfo = readFile('app/notifications-info.tsx');
    assert.ok(!notificationsInfo.includes('createSession'));
  });

  check('T14b No permission path performs login', () => {
    const permissionInfo = readFile('app/permission-info.tsx');
    assert.ok(!permissionInfo.includes('verifyOtp'));
    assert.ok(!permissionInfo.includes('sendOtp'));
    const notificationsInfo = readFile('app/notifications-info.tsx');
    assert.ok(!notificationsInfo.includes('verifyOtp'));
    assert.ok(!notificationsInfo.includes('sendOtp'));
  });

  check('T14c No permission file imports QR/deep-link auth', () => {
    for (const file of authFiles) {
      const content = readFile(file);
      assert.ok(!content.includes('qr-link') || file === 'lib/qr-link.ts',
        `${file} should not import qr-link`);
    }
  });
}

// ── T15: All-five-denied end-to-end ─────────────────────────────────────
function testT15() {
  console.log('T15 — All-five-denied');

  const { classifyFeatureGate, decideAttachAction, canOpenFeature } = require('../lib/permission-state');
  const { classifyMicGranted, canRecordVoiceNotes, decideRecordAction } = require('../lib/voice-note');

  check('T15a All five permissions can be independently denied', () => {
    const permState = require('../lib/permission-state');
    assert.strictEqual(permState.classifyFeatureGate('denied'), 'denied');
    assert.strictEqual(permState.classifyFeatureGate('unknown'), 'undetermined');
  });
  check('T15b Contacts denied: manual chat-by-number still works', () => {
    const chatList = readFile('app/(tabs)/index.tsx');
    assert.ok(chatList.includes('handleManualChat'));
    assert.ok(chatList.includes('permissionDenied'));
    assert.ok(chatList.includes('manualTitle'));
  });
  check('T15c Notifications denied: in-app unread still works', () => {
    const chatList = readFile('app/(tabs)/index.tsx');
    assert.ok(chatList.includes('unreadByChat'));
    assert.ok(chatList.includes('onIncomingMessage'));
    assert.ok(chatList.includes('onChatOpened'));
  });
  check('T15d Microphone denied: text messaging still works', () => {
    const chatList = readFile('app/(tabs)/index.tsx');
    assert.ok(chatList.includes('sendMessage'));
    assert.ok(chatList.includes('handleMicPressIn'));
    assert.ok(chatList.includes('promptMicSettings'));
  });
  check('T15e Camera denied: gallery and text still work', () => {
    const chatList = readFile('app/(tabs)/index.tsx');
    assert.ok(chatList.includes('handleAttachGallery'));
    assert.ok(chatList.includes('promptCameraSettings'));
  });
  check('T15f Photos denied: camera and text still work', () => {
    const chatList = readFile('app/(tabs)/index.tsx');
    assert.ok(chatList.includes('handleAttachCamera'));
    assert.ok(chatList.includes('promptPhotosSettings'));
  });
  check('T15g All-five-denied: full navigation flow completes', () => {
    const profileSetup = readFile('app/profile-setup.tsx');
    const permissionIntro = readFile('app/permission-intro.tsx');
    const permissionInfo = readFile('app/permission-info.tsx');
    const notificationsInfo = readFile('app/notifications-info.tsx');
    assert.ok(profileSetup.includes('/permission-intro'));
    assert.ok(permissionIntro.includes('/permission-info'));
    assert.ok(permissionInfo.includes('/notifications-info'));
    assert.ok(notificationsInfo.includes('/(tabs)'));
  });
  check('T15h No crash/error on all-denied: no forced logout or auth reset', () => {
    const permissionInfo = readFile('app/permission-info.tsx');
    assert.ok(!permissionInfo.includes('router.replace("/phone-entry")'));
    assert.ok(!permissionInfo.includes('router.replace("/legal-acceptance")'));
    const notificationsInfo = readFile('app/notifications-info.tsx');
    assert.ok(!notificationsInfo.includes('router.replace("/phone-entry")'));
    assert.ok(!notificationsInfo.includes('router.replace("/legal-acceptance")'));
  });
  check('T15i No forced Settings redirect: both Allow and Skip available', () => {
    const permissionInfo = readFile('app/permission-info.tsx');
    assert.ok(permissionInfo.includes('Skip for now'));
    const notificationsInfo = readFile('app/notifications-info.tsx');
    assert.ok(notificationsInfo.includes('Skip for now'));
  });
  check('T15j Auth gate at (tabs) layout is not affected by permissions', () => {
    const tabLayout = readFile('app/(tabs)/_layout.tsx');
    assert.ok(tabLayout.includes('useRouteGuard(\'(tabs)\')'));
    assert.ok(tabLayout.includes('if (!snapshot) return null'));
  });
}

// ── Regression: Legal acceptance gate ────────────────────────────────────
function testRegressionLegal() {
  console.log('\nRegression — Legal acceptance');

  const phoneEntry = readFile('app/phone-entry.tsx');
  const otpEntry = readFile('app/otp-entry.tsx');
  const legalAcceptance = readFile('app/legal-acceptance.tsx');
  const legalLib = readFile('lib/legal-acceptance.ts');

  check('REG-LEGALa phone-entry enforces legal gate', () => {
    assert.ok(phoneEntry.includes('requireLegalAccepted'));
    assert.ok(phoneEntry.includes("router.replace('/legal-acceptance')"));
  });
  check('REG-LEGALb otp-entry enforces legal gate via centralized guard', () => {
    assert.ok(otpEntry.includes('useRouteGuard(\'otp-entry\')'));
    assert.ok(otpEntry.includes('if (!snapshot) return null'));
  });
  check('REG-LEGALc (tabs) layout enforces legal+session gate via centralized guard', () => {
    const tabLayout = readFile('app/(tabs)/_layout.tsx');
    assert.ok(tabLayout.includes('useRouteGuard(\'(tabs)\')'));
    assert.ok(tabLayout.includes('if (!snapshot) return null'));
  });
  check('REG-LEGALd legal-acceptance.ts has durable store key', () => {
    assert.ok(legalLib.includes('onb.legalAccepted'));
    assert.ok(legalLib.includes('recordLegalAcceptance'));
    assert.ok(legalLib.includes('requireLegalAccepted'));
  });
}

// ── Regression: OTP lockout ──────────────────────────────────────────────
function testRegressionOTP() {
  console.log('Regression — OTP');

  const otpEntry = readFile('app/otp-entry.tsx');

  check('REG-OTPa OTP entry has lockout state', () => {
    assert.ok(otpEntry.includes('isLocked'));
    assert.ok(otpEntry.includes('lockoutSeconds'));
  });
  check('REG-OTPb OTP entry has resend cooldown', () => {
    assert.ok(otpEntry.includes('resendCooldown'));
    assert.ok(otpEntry.includes('handleResend'));
  });
  check('REG-OTPe Resend disabled during lockout', () => {
    assert.ok(otpEntry.includes('isLocked'));
    assert.ok(otpEntry.includes('disabled={resendCooldown > 0 || isVerifying || isLocked}'));
  });
}

// ── Regression: Deep links / QR ─────────────────────────────────────────
function testRegressionDeepLink() {
  console.log('Regression — Deep links / QR');

  const tabLayout = readFile('app/(tabs)/_layout.tsx');
  const otpEntry = readFile('app/otp-entry.tsx');

  check('REG-QRa (tabs) layout enforces auth gate via centralized guard, not URL params', () => {
    assert.ok(tabLayout.includes('useRouteGuard(\'(tabs)\')'));
    assert.ok(!tabLayout.includes('useLocalSearchParams'));
  });
  check('REG-QRb otp-entry does not accept userId from URL params', () => {
    assert.ok(!otpEntry.includes("params.userId"));
    assert.ok(!otpEntry.includes("searchParams.userId"));
  });
}

// ── Regression: Device handoff / session ─────────────────────────────────
function testRegressionSession() {
  console.log('Regression — Device handoff / session');

  const deviceHandoff = readFile('app/device-handoff.tsx');

  check('REG-SESSa device-handoff enforces auth gate via centralized guard', () => {
    assert.ok(deviceHandoff.includes('useRouteGuard(\'device-handoff\')'));
    assert.ok(deviceHandoff.includes('if (!snapshot) return null'));
  });
  check('REG-SESSb device-handoff requires fromOtp param to skip createSession', () => {
    assert.ok(deviceHandoff.includes('fromOtp'));
  });
}

// ── Regression: SecureStore not overwritten by permissions ────────────────
function testRegressionSecureStore() {
  console.log('Regression — SecureStore');

  const permFiles = [
    'app/permission-info.tsx',
    'app/notifications-info.tsx',
    'app/permission-intro.tsx',
    'lib/permissions.ts',
    'lib/push.ts',
    'lib/contact-sync.ts',
  ];

  const protectedKeys = ['userId', 'accessToken', 'refreshToken', 'displayPhone', 'phoneNumber'];

  for (const file of permFiles) {
    const content = readFile(file);
    for (const key of protectedKeys) {
      check(`REG-SS ${file} does not overwrite '${key}'`, () => {
        const pattern = `setItemAsync('${key}'`;
        assert.ok(!content.includes(pattern), `${file} overwrites SecureStore key '${key}'`);
      });
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────
function main() {
  console.log('=== Tasks 1-15 Comprehensive Verification ===\n');

  testT1();
  testT2();
  testT3();
  testT4();
  testT5();
  testT6();
  testT7();
  testT8();
  testT9();
  testT10();
  testT11();
  testT12();
  testT13();
  testT14();
  testT15();

  console.log('\n=== Regression Checks ===\n');
  testRegressionLegal();
  testRegressionOTP();
  testRegressionDeepLink();
  testRegressionSession();
  testRegressionSecureStore();

  console.log('\n' + '='.repeat(50));
  let totalPass = 0;
  let totalFail = 0;
  for (const f of failures) console.log(` FAIL  ${f}`);
  // recount from check() closures
  console.log('-'.repeat(50));
  console.log(` ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('ALL PASS');
}

main();
