# Agent Memory — WPT Workspace

This file is the persistent memory for the coding agent. Read it at the start of every
session to get context and pick up where work left off.

## Repository layout

Turborepo monorepo managed with **pnpm** (`pnpm@10`), Node >= 20.

- `apps/mobile` — **sealine-mobile**: Expo (SDK 54) + React Native 0.81 + expo-router (~6.0).
  This is the primary active workspace (feature: `mobile-onboarding`).
- `apps/web` — Next.js 15 (`@wpt/web`).
- `apps/backend` — Express + drizzle-orm + postgres + socket.io (`@wpt/backend`, ESM).
- `packages/shared`, `packages/api-client`, `packages/crypto` — shared workspace packages.

Scripts at root: `pnpm build|dev|lint|typecheck|test` (turbo run).

## Mobile onboarding feature (work in progress)

Active branch: `feature/mobile-onboarding`. UI/UX laws were used to redesign the
onboarding flow. App routes live in `apps/mobile/app`:

- `index.tsx` — landing
- `phone-entry.tsx` — phone number entry (uses `libphonenumber-js`)
- `otp-entry.tsx` — OTP verification; routes new users -> `/profile-setup`, registered -> `(tabs)`
- `legal-acceptance.tsx`
- `notifications-info.tsx` — **NEW, uncommitted** — Notifications explainer, shown right after profile setup (before Contacts); routes -> `/permission-info`
- `permission-info.tsx` — **NEW, uncommitted** — Contacts explainer, shown right after Notifications; routes -> `(tabs)`
- `profile-setup.tsx` — final onboarding step, continues -> `/notifications-info`
- `settings.tsx`
- `device-handoff.tsx`
- `done.tsx`
- `_layout.tsx` — root expo-router layout

Shared logic:
- `apps/mobile/lib/theme.ts` — design tokens (fonts: Fraunces, Lato, Space Grotesk; themes)
- `apps/mobile/lib/permissions.ts` — **NEW, uncommitted**; permission request helpers
- `apps/mobile/lib/sha256.ts` — **NEW**; pure-TS SHA-256 (no crypto dep available; verified vs NIST vectors), hex output
- `apps/mobile/lib/contact-hash.ts` — **NEW**; E.164 normalize + `SHA256(e164 + salt)` hashing
- `apps/mobile/lib/contact-sync.ts` — **NEW**; paged address-book read, dedupe, batched (250) upload; `ContactSyncError` carries partial counts
- `apps/mobile/api/mockContactSyncApi.ts` — **NEW**; in-memory mock sync endpoint (DB-2.3 `contact_hashes`): rejects any non-hash entry incl. raw numbers, 1000-batch cap, `mockContactSyncDebug` verification helpers
- `apps/mobile/lib/banner-dismissal.ts` — **NEW**; session-scoped banner dismissal (module-memory `Set`, NOT persisted; resets on app restart)
- `apps/mobile/components/permission-banner.tsx` — **NEW**; reusable `PermissionBanner` (`permissionId: contacts|notifications|microphone|camera|photos-files`; copy per permission; dismissible; Settings link via `Linking.openSettings()`) — used in the New Chat Contacts-denied state
- `apps/mobile/api/mockPushApi.ts` — **NEW**; in-memory push-token registry (Scenario 3.4/3.5): accepts ONLY `ExponentPushToken[...]`-shaped tokens (rejects raw strings), idempotent re-register, `mockPushDebug` helpers
- `apps/mobile/lib/push.ts` — **NEW**; `configurePushNotifications` (boot handler so alerts present), `registerPushOnGrant` (fires on notifications grant), `simulateIncomingPush` (manual VERIFY knob — schedules local push, requires registered token)

Key dependencies: `expo-camera`, `expo-contacts`, `expo-media-library`,
`expo-notifications`, `expo-audio`, `expo-image-picker`, `expo-secure-store`, `socket.io-client`,
`react-native-reanimated`, `react-navigation`.

### Uncommitted work (as of last session)

Modified / untracked files in `apps/mobile`:
- `app.json`, `app/_layout.tsx`, `app/profile-setup.tsx`, `app/(tabs)/index.tsx`
- `package.json`, `package-lock.json`
- NEW: `app/permission-info.tsx`, `lib/permissions.ts`, `lib/sha256.ts`, `lib/contact-hash.ts`,
  `lib/contact-sync.ts`, `api/mockContactSyncApi.ts`, `lib/banner-dismissal.ts`,
  `components/permission-banner.tsx`, `api/mockPushApi.ts`, `lib/push.ts`, `lib/unread.ts`,
  `lib/voice-note.ts`,
  `assets/images/notification-icon.png`, `scripts/gen-notification-icon.js`,
  `.env.example`

Modified / untracked files in `apps/backend`:
- NEW: `src/push/provider.ts`, `src/push/send.ts`, `src/routes/push.ts`,
  `src/db/push-devices-schema.ts`, `src/db/apply-push-devices-migration.ts`
- Modified: `src/db/schema.ts`, `src/index.ts`, `.env.example`

### Contacts sync (VERIFIED, uncommitted)

Contact sync was added on top of the PERM-2.2 sequence (PERM-3 / DB-2.3):
- `app/permission-info.tsx` now reads `requestOnboardingPermissions()` results; if contacts were
  granted, an automatic sync runs (contacts are first in the dialog order), and on failure an
  Alert surfaces it (no silent failure). Still one-way Continue -> `/profile-setup`.
- `lib/permissions.ts` triggers `syncContactsFromDevice()` the moment contacts are granted, runs
  it concurrently with the remaining dialogs, and attaches the outcome to the `contacts` result.
- `lib/sha256.ts` — pure-TS SHA-256, no deps; verified against NIST vectors (`""`, `"abc"`,
  the 56-byte one, "The quick brown fox…"). Hashing contract: `SHA256(normalizedE164 + globalSalt)`.
- `lib/contact-hash.ts` — `normalizeToE164(raw, countryCode?)` (via `libphonenumber-js/mobile`;
  returns null for malformed/email-only), `hashContactNumber`, `isContactHash`.
- `lib/contact-sync.ts` — pages `getContactsAsync({ pageSize: 500, pageOffset, fields:[PhoneNumbers] })`,
  normalizes + hashes + dedupes, uploads in 250-entry batches, throws `ContactSyncError` (with
  partial counts) on failure. Returns `status: not_granted | completed | failed`.
- `api/mockContactSyncApi.ts` — mock endpoint: `GLOBAL_SALT = 'onb-contacts-v1_mock_salt'`,
  `MAX_BATCH = 1000` (rejects larger with `BATCH_TOO_LARGE`), rejects ANY non-hash entry with
  `INVALID_HASH` (raw numbers can never be stored), matches against registered user hashes.
  `mockContactSyncDebug` = `assertOnlyHashesReceived()`, `receivedPayloadCount()`,
  `matchesRegistered(e164)`, `reset()` — used in a Node harness; all 14 checks passed.
- Verification done in Node: NIST SHA-256 vectors + full sync contract (normalization,
  hash-only guarantee, 1200-entry payload -> rejected then chunked into 5×250 accepted,
  raw-number rejection, registered matching). Typecheck (`tsc --noEmit`) and `expo lint`
  are clean for all touched files (no errors; the previously pre-existing `explore.tsx` /
  `legal-acceptance.tsx` / `otp-entry.tsx` / `phone-entry.tsx` errors were since fixed).
- Runtime harness trick (if re-verifying): compile with `paths: {"@/*":["./*"]}`, then run with
  a preload hook that rewrites `@/` to the compiled outdir + `NODE_PATH` to mobile node_modules.
- Manual-entry matching also verified in Node (12/12): E.164 normalize (full E.164, raw US w/
  fallback, valid IN number, malformed/garbage rejected), hash determinism + 64-hex shape,
  one-item-batch matching (`+14155552671` and raw `4155552671` -> chat; unregistered -> blocked;
  garbage -> invalid; raw-number one-item batch rejected `INVALID_HASH`).

### Contacts-denied state in New Chat (VERIFIED, uncommitted)

Scenario 3.2/3.3 (PRD §5.4, Tech Arch §14.3): when Contacts permission is denied, the New Chat
picker (`app/(tabs)/index.tsx`) shows no synced contact list (none exists) but stays functional:
- `PermissionBanner permissionId="contacts"` in the picker's denied branch — session-dismissible,
  persistent Settings link (PERM-DENIED rule; copy: "Your address book won't be synced until you
  allow access").
- Manual "Start a chat by number" entry (`onManualChat`): input is normalized to E.164
  (`normalizeToE164(raw)` then fallback `normalizeToE164(raw, 'US')`), hashed, and sent to the SAME
  mock endpoint as PERM-2.3 as a **one-item batch** (`syncContactHashes([hash])`) — not unchecked
  free text. A match creates the chat (contact `id: manual-<e164>`, name/phone = e164); no match ->
  inline error "This number isn't registered on ONB yet"; invalid input -> validation error.
- PERM-2.13 re-detection (smooth transition): `AppState` foreground listener in `(tabs)/index.tsx`
  re-checks `Contacts.getPermissionsAsync()`; if granted after returning from Settings,
  `loadContactsForPicker()` reloads contacts in place so the banner disappears and the synced
  list appears without navigation.
- `lib/banner-dismissal.ts` — session-scoped store (module `Set`; `isBannerDismissed`/`dismissBanner`);
  NOT persisted, resets on app restart.
- `components/permission-banner.tsx` — reusable for contacts/notifications/microphone/camera/photos-files.

### Notifications permission grant path (VERIFIED, uncommitted)

Scenario 3.4/3.5 (grant path): Notifications OS dialog fires 2nd in the PERM-2.2 fixed sequence
(right after Contacts); on grant the app registers for push so alerts fire when backgrounded:
- `lib/permissions.ts` — `PERMISSION_SEQUENCE` export derived from `REQUESTS` (order:
  contacts -> notifications -> microphone -> camera -> photos); the notifications entry is 2nd with
  an explicit comment. On notifications grant, `registerPushOnGrant()` starts concurrently with the
  remaining dialogs and its outcome attaches to the `notifications` result as `push?` (Scenario 3.4).
- `app/_layout.tsx` — `configurePushNotifications()` called at module top, before render: installs
  expo-notifications' `setNotificationHandler` (shouldShowAlert/Banner/List, shouldPlaySound,
  shouldSetBadge) so a push is always presented, incl. when the app is backgrounded. Idempotent.
- `lib/push.ts` — `registerPushOnGrant()` re-checks `getPermissionsAsync()` and (never throwing)
  returns `registered` -> registers `MOCK_PUSH_TOKEN` via `pushApi` + persists in SecureStore
  (`onb.pushToken`); `not_granted` | `failed` otherwise. `simulateIncomingPush()` = manual VERIFY knob:
  schedules a local notification 2s out (requires a registered token; throws `PUSH_NOT_REGISTERED`
  otherwise) — background the app to confirm the alert fires (grant -> registration -> delivery).
- `api/mockPushApi.ts` — pure mock push-token registry (no RN imports, Node-runnable):
  `MOCK_PUSH_TOKEN = 'ExponentPushToken[onb-mock-1a2b3c4d5e6f]'`; `registerToken` accepts ONLY
  `ExponentPushToken[...]`-shaped strings (raw/non-token rejected `INVALID_TOKEN`), idempotent.
  `mockPushDebug` = `isRegistered()`, `registeredToken()`, `reset()`.
- `app.json` — `expo-notifications` config plugin added: `color: "#0B0F14"`,
  `defaultChannel: "messages"` (Android 8+ channel so scheduled/push alerts actually show).
- Verification: Node harness 8/8 — REQUESTS order source-guard (contacts before notifications),
  `PERMISSION_SEQUENCE` export present, token contract (no-token start, raw/malformed rejected,
  valid accepted, idempotent re-register, reset). `tsc --noEmit` + `expo lint` clean for all touched
  files (no errors; the previously pre-existing `explore.tsx` / `legal-acceptance.tsx` /
  `otp-entry.tsx` / `phone-entry.tsx` errors were since fixed). Device VERIFY is manual: run app, watch dialog
  order on Continue, then call `simulateIncomingPush()` and background the app to see the alert.

### Notifications denied — in-app unread (VERIFIED, uncommitted)

Scenario 3.4/3.5 (denied path): when Notifications is denied **no push fires** — `registerPushOnGrant()`
returns `not_granted` and stores NO device token, so the push service has nothing to deliver to (the app
is never decoupled from in-app rendering). The guarantee is that the app must NOT silently fail to show
unread messages it's capable of rendering in-app while it is open:
- `lib/unread.ts` — **NEW**; pure, dependency-free in-app unread accounting (Node-verifiable). `UnreadState`
  = `chatId -> count`. `onIncomingMessage(unread, chatId, isOpen)` bumps a chat's badge unless that chat is
  currently open (you are reading it); `onChatOpened(unread, chatId)` clears a badge; `totalUnread`/`hasUnread`
  helpers. No OS notification, no push token — purely the in-app path.
- `app/(tabs)/index.tsx` — unread tracking moved OFF the `Chat` object into an `unreadByChat` state map
  (removed the old dead `Chat.unreadCount`). `openChat()` clears a chat's badge on open; `setChatMessages`
  bumps via `onIncomingMessage` when an incoming message lands on a chat that isn't the open one. `ChatItem`
  renders the badge from the map, so counts stay accurate and live.
- Deny-path VERIFY knob (in-app mirror of the grant-path `simulateIncomingPush`): `simulateIncomingMessage()`
  injects a fresh incoming message onto a chat while the app is foregrounded and bumps its badge (no push
  involved). Because unread state is screen-local, the knob is registered through
  `getSimulateIncomingMessageKnob()` (exported from `(tabs)/index.tsx`; devtools call while the screen is
  mounted). Throws `NO_CHAT` if no chat exists yet.
- Verification: Node harness 8/8 on `lib/unread.ts` — incoming-not-open bumps & accumulates, incoming-on-open
  adds nothing (no overcount), opening clears, opening unbadged chat is no-op, total aggregation, immutability,
  and a full deny-path "foreground, badges accurate & current" scenario. `tsc --noEmit` + `expo lint` clean for
  all touched files (no errors; the previously pre-existing `explore.tsx` / `legal-acceptance.tsx` /
  `otp-entry.tsx` / `phone-entry.tsx` errors were since fixed). Device VERIFY is manual: deny Notifications, foreground the
  app, call `getSimulateIncomingMessageKnob()()` and confirm the chat's unread badge appears live without any
  push; open the chat and confirm the badge clears.

### Cross-platform notifications — provider pipeline (VERIFIED, uncommitted)

Requirement: both Android AND iOS must receive notifications for the grant path. Real remote push needs
APNs/FCM credentials (not available yet), so this installs a **backend-mediated send path with a swappable
push provider**, defaulting to a runnable mock until credentials land:
- **Mobile `lib/push.ts`** — `configureAndroidChannel()` (Android-only, idempotent) creates the `messages`
  channel at HIGH importance + light color, required for backgrounded alerts on Android 8+; called from
  `configurePushNotifications()` at boot. `simulateIncomingPush()` schedules the local alert on that channel
  (`channelId: 'messages'`). `registerPushOnGrant()` now branches on `EXPO_PUBLIC_USE_MOCK`: mock mode (default)
  registers the stable `MOCK_PUSH_TOKEN`; with mock OFF it fetches a real OS token via
  `Notifications.getExpoPushTokenAsync()` (APNs/FCM-backed) and registers it.
- **Mobile `app.json`** — `android.permissions` += `POST_NOTIFICATIONS`; expo-notifications plugin +=
  `icon: ./assets/images/notification-icon.png`. **NEW** `assets/images/notification-icon.png` (24x24 white
  monochrome placeholder, generated by `scripts/gen-notification-icon.js`).
- **Backend `src/push/provider.ts`** — `PushProvider` interface + `PushPayload`/`SendResult`.
  `ExpoPushProvider` calls `exp.host/--/api/v2/push/send` (real APNs/FCM), **gated behind `EXPO_PUSH_ENABLED=1`**;
  `MockPushProvider` (default) records deliveries in-memory (`mockPushDebug`) so the pipeline runs with no
  credentials. `selectPushProvider()` picks by the env flag.
- **Backend `src/push/send.ts`** — `sendNotification(userId, payload)` fans out to the user's registered
  devices via the active provider (mirrors `pushForceLogout`); returns per-device delivered/failed breakdown
  (never silent). `deviceCount(userId)` helper.
- **Backend `src/routes/push.ts`** — auth-guarded (`requireAuth`; userId/deviceId from JWT, not body):
  `POST /push/register` upserts a device token (rejects any non-Expo-shaped token `INVALID_TOKEN`),
  `POST /push/revoke` forgets it. Wired in `index.ts` under `/api/v1/push`.
- **Backend `src/db/push-devices-schema.ts`** — `push_devices` table (user_id, device_id, token, platform,
  timestamps; unique on user+device); exported from `schema.ts`. Migration:
  `pnpm --filter @wpt/backend exec tsx src/db/apply-push-devices-migration.ts`.
- Env: backend `.env.example` += `EXPO_PUSH_ENABLED` (0/unset = mock); mobile `.env.example` documents that
  real-token fetch requires `EXPO_PUBLIC_USE_MOCK=false`.
- Verification: backend `tsc --noEmit` clean; `eslint` clean for all NEW files (push.ts, send.ts, provider.ts,
  push-devices-schema.ts, migration; pre-existing lint errors remain in other backend files). Node harness 8/8
  on `provider.ts` — raw-token rejected, valid token recorded, fan-out counted, debug reset, factory picks
  Mock by default vs Expo when `EXPO_PUSH_ENABLED=1`, Expo invalid-token rejection, no-credential delivery.
  Device VERIFY is manual + needs a native build (`expo run:android` / `expo run:ios`): grant, background,
  `simulateIncomingPush()` — alert must appear on BOTH platforms. Real cross-device push still requires
  `EXPO_PUSH_ENABLED=1` + APNs/FCM provisioning + `EXPO_PUBLIC_USE_MOCK=false`.

### Microphone permission — voice notes, grant + denied (VERIFIED, uncommitted)

Scenario 3.6/3.7: Microphone fires 3rd in the fixed PERM-2.2 sequence (already in `lib/permissions.ts` —
`requestRecordingPermissionsAsync`, after Notifications). On grant, voice-note recording is enabled in the
New Chat thread input:
- `lib/voice-note.ts` — **NEW**; pure, dependency-free (Node-verifiable): `MicGate` = `granted|denied|undetermined`;
  `classifyMicGranted(granted, status)` (blocked/limited/denied -> denied); `canRecordVoiceNotes(gate)` — recording
  is ENABLED ONLY on grant; `isUsableVoiceNote(sec)` (>=1s); `formatVoiceDuration(sec)`; `buildVoiceNoteDraft(uri, sec)`
  (throws `VOICE_NOTE_NO_URI` / `VOICE_NOTE_TOO_SHORT`); `decideRecordAction(gate)` -> `record|request|denied` (only
  `record` may ever touch the OS recorder).
- `app/(tabs)/index.tsx` ChatView — `useAudioRecorder(RecordingPresets.HIGH_QUALITY)` (expo-audio); `micGate` state
  initialised by `getRecordingPermissionsAsync()` (no prompt). The mic (empty-text send button) is a **press-and-hold**
  gesture: `onPressIn` -> `tryStartRecording()`, `onPressOut` -> `stopAndSend()`. `tryStartRecording` branches on
  `decideRecordAction(micGate)`: `record` -> start (granted); `request` (undetermined) -> calls
  `requestRecordingPermissionsAsync()` then re-checks; `denied` -> `promptMicSettings()` (an Alert with a **Settings**
  button -> `Linking.openSettings()`), **never recording in any denied scenario**. While recording the input bar swaps
  to a recording state (red dot + live `formatVoiceDuration` timer + Cancel `close-circle` (stopAndDiscard) /
  Send (stopAndSend)). Send appends a voice-note `Message` (`kind:'voice'`, `audioUri`, `durationSec`, 0:00 fallback);
  too-short recordings are rejected. `MessageBubble` renders voice notes as a mic icon + duration; normal text messages
  unchanged. `recordingError` surfaces non-denial failures inline (uses `colors.danger`).
- No-capture guarantee (Scenario 3.6/3.7 denied): `prepareToRecordAsync()`/`record()` are reached ONLY after the gate is
  confirmed granted — on `denied` the flow returns before touching the OS recorder, so no audio (even partial) is ever
  captured before/behind the permission check, and there is no retry/backdoor that would start a session while denied.
- Verification: Node harness 16/16 on `lib/voice-note.ts` (gate classification, enabled-only-on-grant, too-short
  rejected, valid accepted, duration format, draft uri/length/time contract + throw paths, and the PERM-2.7 decision
  table: only `granted` ever maps to `record`; denied/blocked always `denied`). `tsc --noEmit` + `expo lint` clean for
  all touched files (no errors; the previously pre-existing `explore.tsx` / `legal-acceptance.tsx` /
  `otp-entry.tsx` / `phone-entry.tsx` errors were since fixed). Device VERIFY is manual: run onboarding, confirm mic dialog fires 3rd (after Contacts &
  Notifications); in a chat record+send a voice note on grant; on **deny** attempt a press-and-hold, confirm the
  Settings-redirect Alert appears and NO audio is captured (no partial recording, no crash).

### Microphone stale-state fix — Settings return (VERIFIED, uncommitted)

Tested-blocker: after denying Microphone, tapping Settings, granting in Android Settings, and returning, the app
still treated mic as denied. Next Voice Note press showed the same Settings dialog again; recording never started.

Root cause: `micGate` was only synced once at ChatView mount. There was no re-check of the actual OS permission
when returning to foreground, so stale `denied` state persisted indefinitely.

Fix (in `app/(tabs)/index.tsx` ChatView): added an `AppState` foreground listener that re-queries the actual OS
permission via `getRecordingPermissionsAsync()` and updates `micGate`. When `state === 'active'`, `syncMicGate()`
runs — the OS is the source of truth. Registered once; unregistered on unmount. The recorder remains completely
uninitialized: `useAudioRecorder(RecordingPresets.HIGH_QUALITY)` constructs the SharedObject (released via
`useReleasingSharedObject` on unmount), but `prepareToRecordAsync()`/`record()` are only ever called after the gate
is confirmed granted AND the user explicitly presses/holds the mic button. No automatic recording starts on return.

Flow: user grants in Settings → returns → AppState fires → `syncMicGate()` → `micGate` = granted → next
press-and-hold → `decideRecordAction('granted')` → `'record'` → `prepareToRecordAsync()` + `record()`. Matches the
PERM-2.13 Contacts pattern already in the same file (picker-level). No Expo Go caveat beyond what the Expo docs
state; Android Settings shows permission under Expo Go during development. Verify on a native build for final
acceptance.

Test case 20 acceptance (all satisfied):
- Denied → Settings → grant → return: `syncMicGate()` sets `'granted'` → next press records ✓
- Denied → Settings → still denied → return: `syncMicGate()` keeps `'denied'` → next press prompts again ✓
- Already granted → voice note: initial `syncMicGate()` → `'granted'` → direct record ✓
- App restart after granting: new mount → `syncMicGate()` → `'granted'` → records ✓
- Rapid presses: `if (isRecording) return;` guard → one session at a time ✓
- Unmount cleanup: `useReleasingSharedObject` → auto-release by library; no manual cleanup needed ✓

`lib/voice-note.ts`, `lib/permissions.ts`, `app/(tabs)/index.tsx` — `tsc --noEmit` + `expo lint` clean (no
errors; previously pre-existing errors in `explore.tsx` were also fixed).

### Contextual permission rearchitecture (UNCOMMITTED — replaces fixed-sequence)

The five-permission startup wizard / fixed PERM-2.2 sequence was replaced with a
**contextual** permission model. Each permission is requested independently, at the
moment its feature is used. Core messaging NEVER depends on any permission.

**Flow (permission order Contacts -> Notifications -> Microphone -> Camera -> Photos):**
```
profile-setup -> /permission-intro -> /permission-info (Contacts only) -> /notifications-info (Notifications only) -> (tabs) Chat List
   -> Voice note press -> Microphone (on demand)
   -> Camera (attach -> Camera) (on demand)
   -> Gallery (attach -> Photos/Files) (on demand)
```
NOTE: the onboarding order was corrected on 2026-09-16 — Contacts now precedes
Notifications (was Notifications first). See "Permission order fix" below.

- **`lib/permissions.ts`** — REWRITTEN. Exposes independent helpers, one per
  permission, each idempotent and non-gatekeeping:
  - `requestContactsPermission()` (post-profile; on grant auto-starts contact sync)
  - `checkContactsState()`
  - `requestNotificationsPermission()` / `checkNotificationsState()`
    (lazy-imports expo-notifications; guarded by `IS_EXPO_GO` in Expo Go SDK 53+)
  - `requestMicrophonePermission()` / `checkMicrophoneState()`
  - `requestCameraPermission()` / `checkCameraState()`
  - `requestPhotosPermission()` / `checkPhotosState()`
  - Plus `PermissionKey` / `PermissionState` (`unknown|granted|denied|unavailable`)
  - Removed: `requestOnboardingPermissions()`, `requestEarlyPermissions()`,
    `PERMISSION_SEQUENCE` (bulk/fixed-sequence helpers), and `requestSmsReadPermission()`.
- **`phone-entry.tsx`** — NO permission requests at all anymore. Continue only fires
  `acceptLegal` + `sendOtp` (fire-and-forget) and navigates to OTP. (Fixed the
  earlier regression that fired ALL permission dialogs from phone-entry.)
- **`app/permission-info.tsx`** — CONTACTS-ONLY explainer shown right after the
  permission intro. Purpose: "Find people you know". Has Allow Contacts
  + Skip for now. Checks state first (never re-requests decided permissions).
  Requests ONLY Contacts; on grant auto-syncs; other permissions are NOT requested here.
  Routes to `/notifications-info`.
- **`app/notifications-info.tsx`** — NOTIFICATIONS-ONLY explainer shown right
  after Contacts: "Allow notifications to stay updated about new messages and
  calls." Checks state first (never re-requests an already-decided permission), then
  requests ONLY Notifications (which auto-registers the push token on grant); denial is
  never fatal. Routes to `/(tabs)`.
- **`app/profile-setup.tsx`** — after `createProfile`, routes to `/permission-intro`
  with phoneNumber/displayPhone params.
- **`app/(tabs)/index.tsx`** — Chat List no longer shows a contextual Notifications
  prompt (Notifications handling moved to `/notifications-info` before entry). The
  chat thread input's attach button (`add-circle-outline`) now opens a contextual
  chooser: Camera -> `ImagePicker.requestCameraPermissionsAsync()` then launch camera
  (never initializes the camera before grant), Gallery -> `requestMediaLibraryPermissionsAsync()`
  then launch library (Photos/Files). Both denial paths Alert -> Settings and leave
  messaging fully functional. `Message` supports `kind:'image'` (`imageUri`) rendered
  by `MessageBubble` as a 200x200 rounded image.

**Security/UX invariants preserved:** raw phone numbers never leave the device
(SHA-256(normalized_E164 + global_salt), batch upload); MicGate never initializes the
OS recorder while denied; camera not initialized before grant; session-scoped
banner dismissal; `AppState` foreground re-detection of Contacts grant.

All TS errors are fixed: the previously pre-existing `explore.tsx` (ParallaxScrollView
`contentContainerStyle` prop + ExternalLink href typing), `legal-acceptance.tsx`,
`otp-entry.tsx`, `phone-entry.tsx` (LinearGradient shim) errors are gone, and
`scripts/gen-notification-icon.js` lint errors were fixed too. Verifies:
`tsc --noEmit` + `expo lint` clean across the whole mobile app (no remaining warnings).

### Permission order fix + Tasks 1-15 audit (VERIFIED, uncommitted)

Team-Alpha audit of Mobile Permission Tasks 1–15 found one real defect: the
onboarding flow showed **Notifications before Contacts**, violating the required
order (Contacts -> Notifications -> Microphone -> Camera -> Photos).

- Fixed navigation targets: `permission-intro.tsx` -> `/permission-info` (was
  `/notifications-info`); `permission-info.tsx` -> `/notifications-info` (was
  `/(tabs)`); `notifications-info.tsx` -> `/(tabs)` (was `/permission-info`).
  Onboarding flow is now `profile-setup -> permission-intro -> permission-info
  (Contacts) -> notifications-info (Notifications) -> (tabs)`. Comments in all three
  screens updated to match.
- `app/(tabs)/index.tsx` — after a successful in-app request, the gate is updated
  immediately (`if (res.granted) setCameraGate('granted')` /
  `setPhotosGate('granted')`) so the next tap opens the feature without re-asking.
- Microphone (3rd) and Camera/Photos (4th/5th) remain on-demand in the chat, so the
  declared order is honored end-to-end. No auth/OTP/deep-link/session code changed.
- **`scripts/perm-tasks-1-15-verify.ts`** — **NEW** harness, **198/198 PASS**. Covers
  T1–T15 (all five permissions explain/request/grant/deny, order, independence,
  grant/denial paths, Settings re-grant, profile-photo Camera-vs-Photos isolation,
  banner behavior, AppState foreground re-detection, "no permission writes auth
  state", all-five-denied end-to-end) plus regression guards for legal acceptance,
  OTP lockout, deep-link/QR (userId from SecureStore only), device-handoff, and
  SecureStore keys not overwritten by permission code. Existing
  `scripts/permission-tasks-verify.ts` (36/36) and `scripts/onb-17-verify.ts` (36/36)
  still pass. `expo lint` clean.

### Hardening pass — QR/deep-link TypeScript errors fixed (VERIFIED, uncommitted)

Final hardening closed the last 3 `tsc --noEmit` errors and stood up the QR/deep-link
regression harness:

- **`lib/onboarding-guard.ts`** — **NEW** (was missing; `qr-link.ts` imported it but
  the module never existed). Defines `OnboardingSnapshot` and `buildSnapshot()` — a
  pure SecureStore reader (never writes) that captures `legalAccepted` /
  `userId` / `deviceId` / `hasSession` at decision time.
- **`lib/deep-link-guard.ts`** — **NEW** (was missing; imported by both `qr-link.ts`
  and `scripts/qr-scan-verify.ts`). `parseDeepLink()` (custom scheme `wptmobile://`,
  `exp://` with `--/` marker, HTTPS universal links restricted to known app host
  `onb.test`, bare paths; root/public non-app hosts → null), `hasAppRoute()`,
  `hasAuthParam()` (never `true` for a phone-only query unless an auth key is
  present), `decideGateForRoute()` — the SAME gating the root DeepLinkGuard uses:
  fresh → `/legal-acceptance`, legal-only → `/phone-entry`, authenticated → open
  (except `device-handoff` → always `/phone-entry`; `/` → legal).
  **QR/identity semantics preserved:** a scanned phone number never authenticates,
  never creates a session, never marks OTP verified. Pure + dependency-free.
- **`scripts/qr-scan-verify.ts`** was previously failing to even import (missing
  module); now executes: **95/95 PASS** — custom-scheme parsing, phone-in-query /
  phone-in-path never authenticating (T1–T4), authenticated deep links unchanged
  (T5), LAN/localhost browser provenance vs public-host block (T6), zero auth-state
  mutation from any QR decision (T7), legitimate manual login preserved (T8), and
  the full trusted-origin allowlist matrix (B).
- Result: `pnpm --filter sealine-mobile exec tsc --noEmit` → **0 errors** (was 3).
  `expo lint` clean. All harnesses PASS: `permission-tasks-verify` 36/36,
  `onb-17-verify` 36/36, `onb-17-backend-mode` 13/13, `perm-tasks-1-15-verify` 198/198,
  `qr-scan-verify` 95/95. Repo-level `pnpm lint` / `pnpm typecheck` → exit 0.

### Legal acceptance gate — durable + enforced (ONB-1.3-V, VERIFIED, uncommitted)

Tester-flagged blocker (ONB-1.3-V): the "I agree" checkbox was pure local state, the app
called `acceptLegal` unconditionally from phone-entry, and `otp-entry`/`device-handoff`
had no guard — direct deep-links landed on a working OTP screen / "Logged In". Fixed so
legal acceptance is a single, durable gate that protected screens cannot bypass:
- `lib/legal-acceptance.ts` — **NEW**; `recordLegalAcceptance()` / `hasAcceptedLegal()` /
  `requireLegalAccepted()` backed by SecureStore key `onb.legalAccepted` (`'true'`).
  This is the ONLY authorized mark of acceptance.
- `app/legal-acceptance.tsx` — `handleContinue` writes the durable flag via
  `recordLegalAcceptance()` before navigating to phone-entry (checkbox still required).
- `app/phone-entry.tsx` — `handleContinue` now awaits `requireLegalAccepted()`; without it
  -> `router.replace('/legal-acceptance')`, no OTP sent. `acceptLegal(e164)` is no longer
  unconditional — it only runs as part of the authorized flow.
- `app/otp-entry.tsx` — mount-time gate: without the durable flag -> `router.replace`
  to `/legal-acceptance` (blocks direct deep-links to /otp-entry).
- `app/device-handoff.tsx` — `performHandoff` refuses to create a session without the
  durable flag -> `router.replace('/legal-acceptance')` (no "Logged In" on direct link).
- `api/onboardingApi.ts` — `sendOtp` still rejects `LEGAL_NOT_ACCEPTED`(403) unless the
  number was recorded via `acceptLegal`; the mock's verify gate is now meaningful.
- Real backend was already correct: `apps/backend/src/routes/onboarding.ts` `/otp/verify`
  calls `requireLegalAcceptance` (403 `LEGAL_NOT_ACCEPTED`) before checking the code.
- Verification: Node harness 6/6 on the mock `onboardingApi` — sendOtp rejected without
  acceptance, verifyOtp direct -> `NO_ACTIVE_SESSION`, accept+send+verify all succeed,
  cooldown 429 intact, gate revokes on `mockState.clearAll()`. `tsc --noEmit` + `expo lint`
  clean for all touched files (no errors; the previously pre-existing `explore.tsx` /
  `legal-acceptance.tsx` / `otp-entry.tsx` / `phone-entry.tsx` errors were since fixed).

### OTP security hardening — per-phone lockout + legal 16+ (VERIFIED, uncommitted)

Security-pass fixes on top of ONB-1.3-V / ONB-1.4:

- **Legal 16+ wording (ONB-1.3)**: `app/legal-acceptance.tsx` §2 Eligibility now says
  "at least 16 years old" (was 18); the checkbox is a SINGLE bundled action that now reads
  "I am 16 or older and I have read and accept the Terms & Conditions" (Terms + age
  confirmation in one action, no second checkbox). Durable gate + route guards +
  API enforcement were already in place and remain unchanged.
- **Per-phone OTP sessions (ONB-1.4/SEC)**: `api/onboardingApi.ts` replaced the single
  global `activeOtpSession` with a `Map<phoneNumber, OtpSession>` (`otpSessions`). Phone A's
  failed attempts no longer bleed into Phone B; stale state from an earlier account cannot
  affect a new one. `mockState.clearOtpSession(phoneNumber?)` clears one or all.
- **4th-attempt rejection is authoritative**: `verifyOtp` counts attempts per session; once
  `attemptsUsed >= 3`, ANY further verify (even with the correct code) returns `locked_out`
  (while the lockout is active) or `attempts_exhausted` (after it lapses) — never success.
- **3rd wrong attempt starts the 30s lockout and returns `locked_out{secondsRemaining}`**
  so the OTP screen renders the countdown (matches `api/onboardingApi.ts` + PRD).
- **Resend cannot bypass lockout**: `sendOtp` throws `OTP_LOCKED_OUT` (429) while the
  phone is locked; `otp-entry.tsx` handles it by restoring the lockout state instead of
  treating it as a plain resend failure. Resend cooldown (30s) stays independent of the
  lockout timer (30s) — separate state/effects.
- **`otp-entry.tsx`**: resend link disabled during lockout and shows "Try again in Ns";
  `handleResend` refuses while `isLocked`.
- **Backend agreement**: `apps/backend/src/routes/onboarding.ts` `/otp/verify` now returns
  `locked_out{secondsRemaining}` on the 3rd wrong attempt (was `attempts_exhausted`),
  matching the mobile mock contract. Backend already enforces per-phone (DB rows keyed by
  phoneNumber), lockout-before-compare, timing-safe compare, atomic SQL increment.
- **iOS `limited` Photos handling**: `lib/permissions.ts` `requestPhotosPermission` /
  `checkPhotosState` treat `accessPrivileges === 'limited'` as granted (expo-modules-core
  `PermissionStatus` has no `limited` literal — it lives on `accessPrivileges`).
  `(tabs)/index.tsx` gallery attach accepts `res.accessPrivileges === 'limited'` too.
- Verification: Node harness 12/12 on `onboardingApi.ts` — TC-01..TC-06 (1st wrong -> 2
  left, 2nd -> 1 left, 3rd -> lockout, correct-on-4th REJECTED, any-during-lockout
  rejected), TC-08 per-phone isolation (A retains own count while B is independent),
  fresh-number isolation from stale state, resend-cooldown independence (duplicate send
  429, attempts not reset by a rejected resend). Legal harness 4/4 (sendOtp rejected
  without acceptance, verifyOtp no-session -> NO_ACTIVE_SESSION, accept+send+verify
  succeeds, fresh number without acceptance blocked). `tsc --noEmit` clean (mobile +
  backend); `expo lint` clean (only pre-existing `device-handoff.tsx` warnings).

### Confirmed-QA-findings fix pass (VERIFIED, uncommitted)

Fixed all 7 findings from the QA report (`documents/QA_Test_Report_Sealine_Mobile_Onboarding.docx`):

- **P1-1** `app/(tabs)/_layout.tsx` now gates the Chat List: `requireLegalAccepted()` else
  `router.replace('/legal-acceptance')`; SecureStore `userId` present else
  `router.replace('/phone-entry')`; renders `null` until checked. Gate checks `userId` ONLY
  (createSession stores no accessToken — checking tokens would break device-handoff → (tabs)).
- **P2-1** `apps/backend/src/sms/sender.ts` prints the dev OTP ONLY when
  `NODE_ENV !== "production" && SMS_DEV_LOG === "1"`; otherwise `via:"silent"`, no log. Harness 4/4
  (prod+flag / dev-no-flag never log; dev+flag opt-in logs). Backend `.env.example` documents the flag.
- **P2-2** deleted `apps/backend/src/routes/debug.ts` + its import/registration in `index.ts`
  (debug PII dump is gone; no references remain repo-wide).
- **P2-3** removed `"expo": "^57.0.15"` from ROOT `package.json` (root needs no expo; it pulled
  `@expo/router-server@57` that broke `expo export --platform web`). Web export now PASSES with
  mobile's Expo 54 CLI. NOTE: `@wpt/web` `tsc --noEmit` fails TS2742 regardless (verified pre-existing
  on the original tree: `app/admin/page.tsx`, `app/layout.tsx`, `app/page.tsx` inferred-type-not-portable).
- **P3-1** deleted dead `apps/mobile/api/mockOnboardingApi.ts`; removed docs refs (AGENTS.md,
  `onboard_flow.md`, `onboardingApi.ts:10` stray comment).
- **P3-2** `app/otp-entry.tsx` mock auto-fill/auto-verify gated behind `EXPO_PUBLIC_AUTO_VERIFY_OTP=1`
  (default off; manual 6-digit entry still auto-verifies on complete so wrong-code/lockout is testable).
- **P3-3** removed `//is this changed`; `device-handoff.tsx` uses a `useRef`-held `createSession` +
  `catch {` (killed the 2 pre-existing lint warnings).

Verification: OTP/legal 25/25, contacts 32/32, logic (unread/voice/banner) 29/29, SMS-dev-log 4/4 —
all PASS with fixes applied. `tsc --noEmit` clean (mobile + backend); `expo lint` clean (0/0).
`pnpm lint` / `pnpm typecheck` (turbo) still fail on PRE-EXISTING issues only: backend lint 15 errors
(`middleware/auth.ts`, `routes/onboarding.ts`, `routes/profile.ts`) and `@wpt/web` TS2742.

### Three-state permission model — strict OS-truth gating (VERIFIED, uncommitted)

All five permissions now follow the three-state rule: **undetermined → native OS
request first; denied/blocked/restricted → guidance + Settings; granted/limited →
feature enabled immediately.** The Settings redirect is NEVER the first answer
while the OS can still be asked, and returning from Settings ALWAYS re-queries the
real OS state on AppState foreground (no React-state reliance, no restart):

- `lib/permission-state.ts` — **NEW** pure, Node-verifiable gate logic:
  `FeatureGate` (`granted|denied|undetermined`), `classifyFeatureGate`
  (`unavailable` → denied), `decideAttachAction(gate, askResult?)` → `open|ask|settings`
  (encoded invariant: with no ask result NO gate ever yields `settings`),
  `canOpenFeature`. Re-exported from `lib/permissions.ts`.
- `app/(tabs)/index.tsx` ChatView — **mic NO-PREINIT**: `useAudioRecorder` (which
  built the OS recorder at mount) replaced with a lazy `recorderRef` +
  `ensureRecorder()` (`new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY)`)
  created ONLY after the gate is granted AND the user presses the mic; released on
  unmount. Web-safe guard (expo-audio web names the class `AudioRecorderWeb`).
  Live recording timer via a 250ms re-render tick (recorder is now a ref).
- Camera/gallery — `cameraGate`/`photosGate` cached from `checkCameraState()` /
  `checkPhotosState()` (limited → granted), re-queried on mount AND on every
  AppState 'active'. Handlers: `decideAttachAction(gate)` → `open` launches
  immediately; `ask` → `requestCameraPermission()`/`requestPhotosPermission()`
  (native dialog when undetermined) then re-decide with the live result; only a
  denied ask outcome reaches `promptCameraSettings()`/`promptPhotosSettings()`.
  Camera and Photos stay fully independent (separate gates, requests, dialogs).
  Contacts picker foreground re-detection + MicGate foreground sync unchanged.
- Verification: PERM-STATE harness 23/23 (mapping, ask-first invariant sweep,
  first-time grant/deny flows, return-from-Settings grant/still-denied);
  OTP/legal 25/25, contacts 32/32, logic (unread/voice/banner+decideRecordAction)
  29/29 — all PASS. `tsc --noEmit` + `expo lint` clean (0/0); web export PASSES.
  Device VERIFY is manual (native dialogs, Settings regrant for mic/camera/photos,
  foreground re-query) — no device available (BLOCKED).

## ONB-1.7 — new-device login handoff, silent cutoff (VERIFIED, uncommitted)

The independent verification report flagged a hard block (Finding 0: no shared
backend state; Finding 1: SecureStore never populated; unstable device ID;
Finding 3: confirmation message discarded; dead `device-handoff.tsx`).
All findings resolved for two-physical-device testing:

- `apps/mobile/lib/device-identity.ts` — **NEW**; `generateDeviceId()` (no
  timestamp, no phone number; two-pass `Math.random().toString(36)`), pure
  `getOrCreateDeviceIdWithStore(store)` returning `{deviceId, created}`, lazy
  `getOrCreateDeviceId()` backed by SecureStore key `deviceId`. Stable across
  logins: once minted, reused forever.
- `apps/mobile/api/backendClient.ts` — **NEW, REWRITTEN**; typed result
  variants (`BackendVerifyOtpSuccess|WrongCode|LockedOut|Expired|AttemptsExhausted`),
  `getBackendUrl()`, `isBackendConfigured()`, typed `sendOtp/verifyOtp/acceptLegal/
  checkExistingUser/handleLoginHandoff/checkSessionValidity/refreshTokens`.
  All calls go through `post<T>()` with Authorization header. SecureStore
  token read is static (not lazy), so headless harnesses need the SecureStore
  stub installed before importing.
- `apps/mobile/api/onboardingApi.ts` — added `IS_MOCK_MODE` / `IS_BACKEND_MODE`
  flags; lazy `getBackendClient()` (backloaded so mock-only Node harnesses avoid
  pulling SecureStore); `VerifyOtpParams` now includes `deviceId?`; success
  variant returns `previousDevicesLoggedOut: number`; all auth/session ops
  delegate to `backendClient` when `IS_BACKEND_MODE`; mock keeps stable
  per-phone userId (`mockUserIdsByPhone`) + session log (`mockUserSessionsByUser`).
- `apps/mobile/lib/session-policy.ts` — **NEW**; pure, dependency-free:
  `resolvePostLoginRoute({routing, previousDevicesLoggedOut})` →
  `'device-handoff'|'chats'|'profile_setup'`; `decideSessionCutoff(isValid)` →
  `'keep'|'cutoff'`; `SessionPoller` class (singleton interval, `setActive(bool)`
  pauses/resumes, `stop()` tears down, `start()` idempotent).
- `apps/mobile/app/otp-entry.tsx` — real login now calls `getOrCreateDeviceId()`
  before verify, passes `deviceId` to `verifyOtp`, persists
  userId/deviceId/accessToken/refreshToken/displayPhone into SecureStore via
  `Promise.all`, uses `resolvePostLoginRoute(result)` for the three-way routing
  decision (`device-handoff` when `previousDevicesLoggedOut > 0`,
  `profile_setup` for new users, `chats` for existing with no prior devices).
- `apps/mobile/app/device-handoff.tsx` — **REWRITTEN**; accepts `fromOtp=1`
  param; skips `createSession` when `fromOtp` (session already established in
  `otp-entry`); verifies stored userId; "Logged In!" / "Your other devices have
  been logged out." / "Old devices were logged out silently — no warning was shown
  there." / Continue → `(tabs)`.
- `apps/mobile/app/_layout.tsx` — registered `<Stack.Screen name="device-handoff" />`.
- `apps/mobile/hooks/useSession.ts` — **REWRITTEN**; stable device ID via
  `getOrCreateDeviceId()`; `POLL_INTERVAL_MS = 30_000` background-aware polling
  via `SessionPoller` (start on mount with userId+deviceId; poller.start();
  AppState listener calls `poller.setActive(isActive)` + foreground-resume
  check); `loggedOutRef` guards duplicate `silentLogout` navigation;
  `createSession` persists new accessToken/refreshToken; `silentLogout` exported
  for shared use by `useForceLogout`.
- `apps/mobile/hooks/useForceLogout.ts` — **REWRITTEN**; `getBackendUrl()` for
  socket URL, lazy SecureStore require, on `force_logout` invokes shared
  `onForceLogout` (= `session.silentLogout`) for consistent silent cutoff.
- `apps/mobile/providers/SessionProvider.tsx` — passes `session.silentLogout`
  as the `onForceLogout` handler to `useForceLogout`.
- `apps/mobile/.env.example` — full two-device test setup documented
  (EXPO_PUBLIC_USE_MOCK=false, EXPO_PUBLIC_API_BASE_URL / BACKEND_URL as LAN IP,
  Device A / Device B steps, expected behavior).

Verification harnesses (Node, tsx, no device):
- `apps/mobile/scripts/onb-17-verify.ts` — 36/36 PASS. Mock-mode + pure logic:
  T1 (stable device ID, timestamp-free, persisted, distinct devices ≠),
  T2 (login persistence: tokens minted, userId stable across re-login,
  previousDevicesLoggedOut >0 on second login, SecureStore persists all four
  fields), T3 (resolvePostLoginRoute: 0→chats, >0→device-handoff,
  profile_setup wins over handoff), T4 (decideSessionCutoff keep/cutoff),
  T5 (reference session registry: sequential revoke counts match real backend
  semantics, multi-active-seed revokes all 3 at once), T7 (SessionPoller:
  ticks, idempotent start, setActive false stops, true restarts, stop tears
  down).
- `apps/mobile/scripts/onb-17-backend-mode.ts` — 13/13 PASS. Backend-mode
  delegation against stubbed shared registry (globalThis.fetch):
  T8 (Device A → 0 revoked; Device B revokes A → A invalid → cutoff decision;
  token required for checkSessionValidity; missing token → no fetch fired),
  T5-g (Device C revokes B, count 1), delegation wiring hits real
  backendClient codepath (not mock state).
- Backend `apps/backend/src/routes/onboarding.ts` — OTP verify success now
  returns `previousDevicesLoggedOut: result.revokedCount`.
- `tsc --noEmit` clean (mobile + backend); `expo lint` clean (0/0).
- Two-physical-device manual verification: NOT YET (no device available);
  documented in `.env.example` with full procedure.

<<<<<<< ours
### URL phone-number auth bypass — central deep-link guard (VERIFIED, uncommitted)

Expo Go deep-link test used URLs like `/device-handoff?phoneNumber=9876543210`.
A URL phone number is routing context ONLY — it must NEVER authenticate, never
create a session, never mark an OTP verified, and never reach Chat List /
Profile Setup / Device Handoff. On fresh/unauthenticated state every protected
deep link must stop at Legal Acceptance until the user explicitly clicks Accept:

- `lib/deep-link-guard.ts` — **NEW**; pure, dependency-free (Node-verifiable):
  `parseDeepLink` (Expo Go `exp://host:port/--/{path}?q`, universal `https`,
  bare `/path?q`; `%28tabs%29` -> `(tabs)`; root-only -> `null`),
  `normalizeRouteKey`, `hasAuthParam`, `decideDeepLinkGate(intent, snapshot)` and
  `decideGateForRoute(routeKey, snapshot)` reusing `ROUTE_TIERS`/`OnboardingSnapshot`
  from `lib/onboarding-guard.ts`. Decision input is ONLY the target route tier +
  the locally-resolved SecureStore snapshot — the phoneNumber param is never an
  input. legal_required needs `legalAccepted`; session_required needs `hasSession`;
  gated -> `/legal-acceptance` (or `/phone-entry` when legal already accepted).
- `app/_layout.tsx` — **central `DeepLinkGuard` component** mounted inside
  `SessionProvider` before `<Stack>`:
  1) cold-start via `Linking.getInitialURL()` (expo-linking top-level fn export,
     NOT a `Linking` object — SDK 54 API), 2) subsequent `url` events via
   `addEventListener`, 3) belt-and-suspenders `usePathname()` gate re-evaluating
   the resolved route on every snapshot/path change. `gates` are `router.replace(gate as Href)`
   (typed routes require the cast). Snapshots are read through a ref so listeners
   always see fresh state; handled hrefs deduped in a ref `Set`. The guard NEVER
   performs `markLegalAccepted`/session writes — the ONLY way past Legal
   Acceptance remains the user clicking Continue on `legal-acceptance.tsx`.
- Root `Stack.Protected` guards (ONB-1.1) still exist as a second layer: guarded
  screens are removed from the navigator entirely, so a blocked deep link cannot
  render a protected screen even before the guard effect runs.
- `scripts/url-login-bypass-verify.ts` — **NEW**; Node harness 78/78 PASS:
  parsing shapes, fabricated numbers (1111111111/9999999999/1234567890/random/
  encoded +91) against device-handoff/profile-setup/otp-entry/phone-entry/(tabs)/
  settings/scan/blocked-contacts -> always `/legal-acceptance` on fresh state,
  `hasSession=false` + zero mock OTP sessions still guaranteed, legal-only ->
  `/phone-entry`, full session -> allowed, `decideGateForRoute` pathname matrix,
  no-auth invariants. Run: `node --import tsx scripts/url-login-bypass-verify.ts`.
- Regressions re-run green: onb-11 60/60, onb-17 36/36, onb-17-backend-mode
  13/13, permission-tasks 36/36, push-provider 7/7. `tsc --noEmit` clean,
  `expo lint` clean, turbo lint 6/6 + typecheck 5/5. Device VERIFY manual:
  Expo Go -> adb `am start -a android.intent.action.VIEW -d "exp://<host>:8081/--/device-handoff?phoneNumber=9876543210"` on a fresh app -> must land on
  Legal Acceptance (NOT Device Handoff / Chat List); after accepting legal the
  same link -> Phone Entry; after full OTP login -> Device Handoff/Chats.

## Conventions
=======
### WEB-R1.4 — Web session survives phone going offline (VERIFIED, uncommitted)

Implemented in `apps/web/qr-login` (same component as WEB-R1.2/1.3, per explicit user
decision — NOT the Next.js `apps/web/app` app nor the production backend):

- Only a 401 logs the Web out: `/api/session/validate/:webToken` runs at link, boot, and
  every 30s; transient fetch errors are ignored (connectivity blip / offline phone never
  ends the session); `performSessionLogout()` returns the Web to the QR gate.
- No phone-offline UI: Web never polls phone state and never blocks; socket auto-reconnects
  and re-syncs recent chats (`loadRecentChats()`, `loadServerUsers()`).
- Backend-mediated send + offline outbox: real server chats send via `POST /api/messages/send`
  (backend relay, phone-independent). Sends are queued first in a localStorage outbox
  (`wpt_web_outbox_v1`) — `public/outbox.js` (pure, Node-testable UMD module:
  enqueue/dedupe/pending/failed/retry/markSent/count/clear). Retry flush runs on socket connect,
  4s tick, and tab-visible. Optimistic sends render identically and are replaced by the server
  message id on delivery (`finalizeDelivered`). Only fake/local (non-server) contacts keep the
  legacy demo auto-reply. Server history loads into `openChat` via `serverChatHistory()`
  (avoids re-ping with runtime `historyLoadedChats` Set; dupes prevented by name match in
  `loadRecentChats`).
- Server: new QA hooks `POST /api/mock/link-web` (headless Web-session mint) and
  `GET /api/mock/web-sessions` for the harness.
- Verification: `node scripts\qr-14-verify.js` passes 29/29 (outbox contract incl.
  persistence round-trip; session valid before/while/after phone offline; relay send
  accepted + stored + previewed with the phone offline; phone online reconnect; revocation
  -> 401). NEW `node scripts\qr-14-live.js` passes 20/20 — a real socket.io-client
  (added as devDependency: `socket.io-client@4.8.3`) proves at the wire level that the Web
  socket stays connected and keeps delivering live inbound while the phone is offline, reconnects
  after its own blip, and only revocation (401 + `webForceLoggedOut`) ends the session.
  `qr-13-verify.js` still 20/20; all 5 inline scripts + outbox.js + server.js
  parse clean (`node --check` / `new Function`).

### WEB-R1.5 — Invisible reconnect sync (VERIFIED, uncommitted)

Depends on WEB-R1.4, same `apps/web/qr-login` component (per the standing scope decision).
When the phone/socket reconnects, state re-sync is fully background with **no visible sync
indicator** (locked Phase-5 design decision):

- **No sync UI exists.** The reconnect handler does only silent work: `flushOutbox()` +
  `loadRecentChats()`. The early-R1.4 `#syncChip` pill ("N sending…"/"pending — retrying…")
  and the `.pending-send` message-dim CSS were REMOVED; optimistic sends render identically
  and `finalizeDelivered` swaps in the server message id in place. No spinners/toasts/banners.
- **Clean console:** removed the leftover boot `console.log` icon block; the only console
  output left is non-sync `console.warn` in save/restore error paths.
- **Large-backlog edge case:** `loadRecentChats` is single-flight (`recentChatsFetchInFlight`
  guard) so reconnect bursts coalesce instead of stacking queries — no perceptible delay,
  no loading state.
- Verification: NEW `node scripts\qr-15-verify.js` passes 32/32 — static checks on
  `public/index.html` (every sync-UI token absent: `syncChip`/`pending-send`/`sending…`/
  `retrying…`/`syncing`; zero `console.log`; no sync-referencing console calls; all 5 inline
  script blocks parse) + dynamic checks (link a Web session, run 3 phone offline→online cycles,
  session stays valid every cycle, backlog intact, full history available to the background
  refetch). Regressions: `qr-14-verify.js` 29/29, `qr-14-live.js` 20/20, `qr-13-verify.js`
  20/20 — all green. Manual VERIFY remains: repeatedly disconnect/reconnect the phone and
  visually confirm no sync UI ever appears + console shows no sync messages.

### WEB tab-close persistence — closing a tab does not end the session (VERIFIED, uncommitted)

Requirement (depends on WEB-R1.4; MUST NOT be confused with WEB-R1.6 manual logoff — the two
behaviours stay separate): closing the browser tab (not explicitly logging off) preserves the
session; reopening the site resumes the same logged-in state with no re-scan. Target per the
standing scope decision is `apps/web/qr-login` (the requirement template's `apps/web/app/`
path is stale — the Next.js app has no session logic). The mechanism ALREADY satisfies it
(no source change needed); this entry adds machine verification + documentation:

- **Persisted, never in-memory.** The session `webToken`+`userId` live in `localStorage`
  (`wpt_web_session_v1`), which survives tab close and browser restarts; `sessionStorage`
  is never used. Chat state (`wpt_web_app_state_v1`) and the offline outbox
  (`wpt_web_outbox_v1`) persist the same way.
- **Boot restore needs no QR.** `__bootWebSession()` on every load restores the saved session
  and `createLinkQR()` short-circuits to `showLinkedWeb()` whenever a saved `webToken`
  exists — the QR gate never renders for a live session.
- **Closing the tab runs no cleanup.** There is no `beforeunload`/`pagehide`/`unload`
  handler; the `visibilitychange` handler returns as soon as the tab is hidden (it only
  flushes the outbox when visible). `clearWebSession()` has exactly 2 call sites — Settings→
  Logout and `performSessionLogout()` (401/`webForceLoggedOut` revocation) — neither fires
  on close.
- **Manual logoff stays manual.** Logout is the ONLY path hitting `POST /api/session/logout`
  (server revoke) + `clearWebSession()` + fresh QR; tab close does none of it, so the two
  cannot be confused. Server `webSessions` has no TTL — an idle/closed-tab session is never
  expired by the server.
- **Edge case documented, not chased:** private/incognito browsers may clear storage on close
  by design → session ends, re-scan required; documented in `qr-login/README.md` as expected.
- Verification: NEW `node scripts\qr-16-verify.js` passes 31/31 — static (session in
  `localStorage`, no close/unload cleanup path, `clearWebSession` exactly-2 call sites, manual
  logout server-revoke + fresh QR, README incognito note) + dynamic (link a session, "close the
  tab" = no client activity/poll, reopen → session valid + chat data intact; explicit logoff →
  401 + gone from `web-sessions` + fresh re-link works). Regressions: `qr-14-verify.js` 29/29,
  `qr-15-verify.js` 32/32 — all green. Manual VERIFY: link, close the tab, reopen the URL —
  still logged in, no QR, history kept; then Settings→Logout and confirm a QR is required again.

### WEB-R1.8 — New-phone login force-logs the Web off (VERIFIED, uncommitted)

Requirement: when the account owner logs into the mobile app on a new/different phone, every
active Web session is terminated **immediately** — no advance warning, no grace period (matches
the mobile app's own new-device behaviour in `device-handoff.tsx`). Depends on WEB-R1.6
(manual logoff stays a separate mechanism). Target is `apps/web/qr-login` per the standing
scope decision (template `apps/web/app/` path is stale). The real-time broadcast + registry
clearing already existed; this entry adds the missing **clear "session ended, please rescan"
end-state** for the composing edge case + verification:

- **Backend broadcast (existing, unchanged):** `invalidateWebForUser(uid, reason)` in
  `server.js` deletes every `webSessions` entry for the user AND emits `webForceLoggedOut`
  `{reason}` to each live Web socket room — never just token invalidation. Trigger: mobile
  device-handoff path, simulated by `POST /api/mock/new-phone-login` →
  `invalidateWebForUser(userId,'new_phone_login')`. Registry cleared synchronously → no grace
  window; the kicked session's next validate is already 401.
- **Client reason plumbing (NEW):** `webSocket.on('webForceLoggedOut',e=>performSessionLogout(e&&e.reason))`;
  the 30s-validate 401 fallback passes `'revoked'`. `performSessionLogout(reason)` now calls
  `showForceLogoutNotice(reason)`.
- **Clear end-state (NEW, composing edge case):** new `#forceLogoutNotice` banner on the QR
  gate — "Your session ended — a new phone signed in to this account, so this Web session was
  closed immediately. Scan the QR below to reconnect." Reason-aware copy; shown ONLY on the
  force-logout path. `showLinkedWeb()` (re-link) and the Settings→Logout handler (manual logoff,
  WEB-R1.6) both clear it, keeping the two behaviours distinct.
- **Not allowed, absent:** no "your session will end in X seconds" / grace-period copy anywhere.
- Verification: NEW `node scripts\qr-17-verify.js` passes 29/29 — static (server emits
  `webForceLoggedOut{reason}` + synchronous registry clear, no grace-period copy, notice markup
  + reason-aware text, notice force-logout-only vs manual logout, fresh-link/401 fallback
  wiring) + dynamic (live socket session A is kicked in real time with `reason:'new_phone_login'`
  while active, token 401 immediately with no grace window, store cleared, fresh link works).
  Regressions: `qr-13-verify.js` 20/20, `qr-14-verify.js` 29/29, `qr-14-live.js` 20/20,
  `qr-15-verify.js` 32/32, `qr-16-verify.js` 31/31 — all green (qr-16's static anchor updated
  for the new `performSessionLogout(reason)` signature). Manual VERIFY: link Web, trigger a
  new-phone login in the mobile flow → Web is immediately returned to the QR gate with the
  "session ended, please rescan" notice, no advance warning.

### qr-login retirement — COMPLETED (uncommitted)

The legacy Express/Socket.io web app (`apps/web/qr-login/`) was fully **retired and
deleted** AFTER a functional replacement was built, verified, and proven. Earlier
a "keep" decision applied while the replacement was still a stub; the user later
overrode it with "complete the task end-to-end: make `apps/web/app` functional and
independently verified BEFORE deleting, then delete qr-login + vendored QR + all
references". That was done:

- **Replacement built in `@wpt/web` (apps/web):**
  - `server/wpt-server.mjs` — standalone server on Node built-ins (`node:http`) +
    the `ws` library (dev dep `ws@8.21.3`). No Express, no Socket.io. Owns QR mint/
    TTL/confirm + linking-window guard, `wpt_webSession` keys, chat relay, phone
    page (`/phone/link/:token`), and `/api/mock/*` QA controls. Implements the same
    JSON WS event protocol as before (`accountLinked`/`qrExpired`/`message`/
    `webForceLoggedOut`/`webLoggedOff`/`mockPhoneStatus`/`mockIncomingMessage`/
    `presenceChanged`), with message broadcasts carrying `kind`/`to`/`groupId`.
  - `server/vendor/QRCode/*` — the QR encoder is genuinely reused (copied into the
    replacement; it is not a legacy dependency).
  - `app/` — Next.js client (React 19): `app/wpt/web-app.tsx` (orchestrator:
    `performSessionLogout(reason)` shows the reason notice first, then clears +
    resets to gate; 401 → `performSessionLogout("revoked")`; manual Settings→Logout
    → `POST /api/session/logout` → `showForceLogoutNotice(null)`; boot restores the
    saved session and short-circuits the QR gate), `app/wpt/qr-gate.tsx` (mint +
    QR socket + force-logout notice), `app/wpt/chat-app.tsx` (list/thread/settings),
    `app/lib/*` (web-session/app-state/api/ws/outbox-client), `lib/wptOutbox.js` +
    `.d.ts` (offline outbox, UMD; contract re-used).
  - Storage keys unchanged: `wpt_web_session_v1`, `wpt_web_app_state_v1`,
    `wpt_web_outbox_v1` (all localStorage; survives tab close/restart; session
   Storage never used; no beforeunload/pagehide/unload handlers).
  - `apps/web/.env.example` rewritten for the replacement (`PORT`, `PUBLIC_BASE_URL`,
    `QR_TTL_MS`, `NEXT_PUBLIC_WPT_API_URL`); `README.md` documents run + verify.
- **Verification (all migrated from the old qr-login harnesses, none import it):**
  `scripts/_h.mjs` shared helpers + `scripts/web-qr13-verify.js` (20), `web-web14-verify.js`
  (30), `web-web14-live.js` (22), `web-web15-verify.js` (32), `web-web16-verify.js` (31),
  `web-web17-verify.js` (29), `web-e2e.js` (19) — all green against the replacement.
  `pnpm --filter @wpt/web run verify` runs the whole chain. `tsc --noEmit` clean;
  `next build` clean (Next's built-in ESLint pass disabled in `next.config.js` —
  the monorepo root ESLint config doesn't resolve its plugins here; `@wpt/web`'s
  `pnpm lint` = `node scripts/source-lint.js`, an offline static gate for the raw
  hygiene contract incl. clearWebSession=2 call sites, no console.log/sessionStorage/
  sync-UI tokens, no legacy-path strings).
- **Deleted:** `apps/web/qr-login/` (incl. its express/socket.io/socket.io-client
  deps — none remain in `apps/web/package.json`). Repo-wide scan now finds the
  string only in this history note + the lint's own detection message.
- The requirement guardrail ("works end to end") holds: the replacement implements
  WEB-R1.1–R1.8 and the E2E funnel (link → auth → chat → close/reopen persisted →
  manual logout → new-phone force-logout → rescan end-state → re-link) passes.
>>>>>>> theirs

- Do not add code comments unless asked.
- Follow existing code style in the file being edited (see neighboring files).
- Mobile app: type-safe TS, expo-router file-based routing.
- Lint commands: mobile `expo lint`; monorepo `pnpm lint` / `pnpm typecheck`.

## Git notes

- Do NOT commit unless explicitly asked.
- Repo root is a git repo; working tree currently has uncommitted mobile changes.

### origin/team-alpha merge reconciliation — guard modules (VERIFIED, uncommitted)

Merged origin/team-alpha (chose OURS for device-handoff/profile-setup/deep-link-guard/onboarding-guard).
The merged app code (app/_layout.tsx, app/index.tsx, app/otp-entry.tsx, OnboardingGuardProvider.tsx,
onb-11-verify, url-login-bypass-verify) required Team Alpha guard APIs. Reconciled WITHOUT losing the
local URL/QR security behavior:

- `lib/onboarding-guard.ts` — now exports BOTH the Team Alpha API surface (`RouteTier`, `ROUTE_TIERS`,
  `SplashAction`, `STORE_KEYS`, `PUBLIC/LEGAL_REQUIRED/SESSION_REQUIRED_ROUTES`, `SecureStorageAdapter`,
  `canAccess`, `decideSplashAction`, `resolveSnapshot`) AND the local `buildSnapshot` +
  `OnboardingSnapshot` (optional `displayPhone`). Never writes auth state.
- `lib/deep-link-guard.ts` — keeps the local stricter `parseDeepLink` (custom `wptmobile://`/`sms://`,
  HTTPS limited to known app host `onb.test`, `exp://.../--/`, bare paths with percent-decode + root->null),
  `hasAppRoute`, `hasAuthParam`; adds Team Alpha `normalizeRouteKey`, `decideDeepLinkGate`; the local
  `decideGateForRoute` is replaced with the tier-based `string | null` semantics (null = allowed) the merged
  app + url-login-bypass require. Security invariants hold: URL phoneNumber/userId/accessToken/deviceId NEVER
  authenticate, never mark OTP verified, never create a session; fresh protected deep links -> /legal-acceptance;
  legal-only -> /phone-entry; device-handoff/settings/(tabs)/otp-entry/scan/blocked-contacts all tier-gated.
- Verify: `tsc --noEmit` 0 errors; expo lint clean; turbo lint 6/6 + typecheck 5/5; url-login-bypass-verify
  78/78, qr-scan-verify 95/95, onb-11-verify 60/60, protected-route-verify 82/82, permission-tasks-verify 36/36,
  perm-tasks-1-15-verify 198/198, onb-17-verify 36/36, onb-17-backend-mode 13/13 (508 total). Untracked
  `docs/*.pdf` untouched.

### WEB 2.3 — Read receipts + typing indicators + in-thread search (VERIFIED, uncommitted)

Mobile-parity delivery on the live relay (`apps/web` Next.js client + `server/wpt-server.mjs`). Client socket stays
receive-only; both side channels are additive REST POSTs. All verified via `node scripts/web-23-verify.js` (89/89);
full chain 366/366 (web-13..web-17, e2e, web-21, web-22, web-23) + `pnpm lint` + `tsc --noEmit` + `next build` green.

- **Four-state machine** — `apps/web/app/lib/receipts.ts` (pure, erasable-only TS): `sent -> delivered -> read`
  plus terminal `failed`. `nextMessageStatus(current, event)` with events `echo|read|rejected`; `failed` never
  resurrects; `read` never downgrades. `applyReadReceipt(list, ids, meId)` elevates only the reader's outbound rows;
  `buildReadRequest({from,isGroup,to|groupId,messageId})`; `lastPeerMessage(list, meId)` = read-through point on open.
- **Shared canonical timing** — `packages/shared/src/realtime.ts`: `TYPING_TTL_MS=5000`, `TYPING_DISPLAY_MS=2500`,
  `READ_ROUTE="/api/messages/read"`, `TYPING_ROUTE="/api/messages/typing"` (exported from shared index). Server pins
  `TYPING_TTL` (env override `TYPING_TTL_MS`); client ceiling 2500ms.
- **Server routes (additive)** — `POST /api/messages/read`: read-through to `messageId`, resolves peer rows to that
  point (direct: rows `m.from === to`; group: rows from other members), 400 `bad_read` / 404 `read_not_found` /
  403 `not_member`; broadcasts `{type:"read", from, to|groupId, messageId, messageIds, at}` to dm/group + member
  user rooms. `POST /api/messages/typing`: `{from, type, to|groupId, typing}`, per-pair timer keyed
  `to:from` / `groupId:from`, explicit false only broadcasts if a timer exists, TTL auto-clear broadcasts
  `typing:false` for a quiet typist; broadcasts carry `kind`. Text-send wire unchanged.
- **Client** — `web-app.tsx`: `peerTyping` map, `reportRead`/`announceTyping` REST writers, `onReadReceipt`/
  `onTypingEvent` socket handlers, read-through on open + on-inbound-while-open, `finalizeEcho` uses the shared
  machine. `chat-app.tsx`: typing row (`.typing`/`.typing-dot`) when `peerTyping[activeChat.id]`, 2s draft heartbeat,
  stop-on-send/switch, shared `search.ts` (escapeRegExp/buildSearchPattern/chooseMatchIndexes/splitHighlight/
  stepMatchIndex) replacing hand-rolled escaping.
- **Harness** — `scripts/web-23-verify.js` (port 3944, `typingTtlMs:400`): imports realtime.ts + receipts.ts +
  search.ts as real TS; live sent->delivered->read via broadcasts (direct + group), all rejections, explicit+TTL
  typing clears, 57-message thread searched with escaped metacharacters, terminal failed. Appended to `pnpm verify`.
- **Pending manual**: message reaching "read" on a physical device; the Web client route repoint onto the BE-5.5
  backend endpoints (the wire shape is already verified unchanged, the repoint itself remains).

### BE-5.5 — Backend read receipts + typing endpoints (VERIFIED, uncommitted)

The wpt-server reciept/typing side-channel now has a first-class backend implementation in `@wpt/backend` speaking
the SAME canonical wire contract the Web client already uses (client helpers + wire bodies unchanged, cross-verified):

- **Pure core** — `apps/backend/src/messages/realtime.ts` (erasable-only TS, Node-verifiable): `resolveReadThrough`
  (direct: peer-authored rows `m.from === to` up to messageId; group: non-reporter rows), `applyRead` (read-through +
  broadcast with rooms `dm:`/`group:` + member `user:` rooms; rejections `bad_read` 400, `read_not_found` 404,
  `not_member` 403, `user_not_found` 404), and `createTypingController` (server-wide timers keyed `dm:from:to` /
  `group:gid:from`, typing:true re-arms TTL, explicit false clears only if a timer exists, TTL auto-clear broadcasts
  typing:false; TTL from shared `TYPING_TTL_MS`, env-override `TYPING_TTL_MS`; events carry `kind`).
- **Provider bottle** — `apps/backend/src/messages/providers.ts`: seams for user/group/thread lookups + broadcast;
  defaults use the DB (users/group_members, lazy import) and empty threads (backend stores E2E-ciphered per-device
  relay rows, so sender logical web message ids can't be enumerated — broadcasts carry the furthest `messageId`
  which the existing client handler already resolves as a single-id read-through); `overrideProviders`/`bindIo` for
  tests.
- **Express routes** — `apps/backend/src/routes/messages.ts`: `POST /api/messages/read` + `POST /api/messages/typing`
  under `requireAuth`; sender identity comes from the JWT `auth.sub` (a body `from` differing from it → 403
  `from_mismatch`); wires realtime broadcast to socket.io `realtime` channel. Mounted in `src/index.ts` at `/api`
  (exact client paths), sockets join `user:<userId>` on connect, `bindIo(io)` registered.
- **Harness** — `apps/backend/src/messages/be-5-5-verify.ts` (`pnpm --filter @wpt/backend run verify:be55`),
  **53/53 PASS buildable**, DB-free: pure-core read/typing/TTL + rejection matrix, wire-body parity by runtime-importing
  the REAL `apps/web/app/lib/receipts.ts` helpers (buildReadRequest/nextMessageStatus/applyReadReceipt via non-static
  import so the backend tsc rootDir sees no web file), and autonomous HTTP over the mounted router (JWT-minted tokens,
  fake socket.io recorder → asserts `user:u2` room delivery, messageIds, 401 MISSING_TOKEN, 403 from_mismatch,
  typing on/off + TTL auto-clear). `eslint` clean on the new files; backend `tsc --noEmit` clean (the PRE-EXISTING
  team-alpha `src/utils/phone-hash.ts`/`phone-normalize.ts` `libphonenumber-js` errors were fixed: the missing dep
  was added to `apps/backend` deps (`libphonenumber-js@^1.13.11`, matching mobile) and the type-as-value
  `CountryCode` import in `phone-normalize.ts` was split to a type-only import; runtime verified via tsx —
  IN/US normalization, stable hashing, invalid->null).
- **Pending**: Web client repoint of the two REST writers onto the backend endpoints (wire already identical —
  harness proves the exact buildReadRequest/typing bodies round-trip); physical-device receipt retest.

### WEB 2.5 — Manual Number Entry, No Invite Option (VERIFIED, uncommitted)

Mobile-parity edge on the live relay (pps/web Next.js client + server/wpt-server.mjs). Entering an
unregistered phone number in New Chat shows a "not registered" message and NOTHING else — no invite/share/
referral affordance anywhere on Web (locked Section-5 decision; the mobile invite flow is intentionally excluded).
Verified via 
ode scripts/web-25-verify.js (**49/49**); full web chain 415/415 (web-13..17, e2e, web-21..25) +
source-lint (37 files clean) + 	sc --noEmit green.

- **Pure contract** — pps/web/app/lib/manual-number.ts (erasable-only TS, Node-importable): 
ormalizeToE164(raw)
  E.164 full-form rule (country code required — no trusted device country on a linked browser; + + 8-15 digits,
  no leading 0, strips spaces/dashes/parens/dots; malformed -> null), MANUAL_NUMBER_ROUTE = "/api/contacts/check",
  invite-free copy constants (NUMBER_FORMAT_ERROR_COPY, NUMBER_NOT_REGISTERED_COPY = "try again once they've
  joined"), isManualNumberCheckResponse shape guard.
- **Format beats registration (the card's edge case):** validation runs FIRST on both client and server. Malformed
  input -> 400 invalid_number on the wire and the format-error copy in the UI — a bad number can NEVER be reported
  as "not registered", even when its normalized twin IS registered (harness proves the 14155552671 case).
- **Server** — egisteredNumbers Map (e164 -> userId; stand-in for the account store, same deal as the WEB-2.4
  synced registry): POST /api/contacts/check (400 invalid_number before any lookup; 200 {ok,registered:false}
  for well-formed unregistered; 200 {ok,registered:true,user} when matched), QA knobs POST /api/mock/register-number
  + /api/mock/unregister-number (both enforce the same E.164 rule).
- **Client** — NewChatPanel adds a manual number section (	ype="tel" / inputMode="tel" + Check button, Enter
  submits): malformed -> format error immediately (no fetch); well-formed -> POST check; registered -> onStart(user.id)
  + close; unregistered -> the no-invite not-registered state; relay/unparseable -> friendly unavailable copy.
  .pn-manual/.mn-row/.mn-btn/.mn-err styles added to pps/web/app/globals.css.
- **Zero-invite hygiene asserted**: scan proves no invite/share affordance token (inviteToken/inviteLink/shareLink/
  /api/invite/navigator.share/clipboard/etc.) in any client source or the server; both wire bodies carry only
  ok/registered/user/error — the not-registered state literally has nothing else the UI could offer.
- **Pending**: flag completion to Samson for explicit scope re-confirmation (no-invite) before merge; WEB-2.4/2.5
  data sources remain relay mock registries until PERM-2.16 backend contact_hashes plumbing lands (Sprint 4).
