# Agent Memory — WPT Workspace

This file is the persistent memory for the coding agent. Read it at the start of every
session to get context and pick up where work left off.

## Repository layout

Turborepo monorepo managed with **pnpm** (`pnpm@10`), Node >= 20.

- `apps/mobile` — **@wpt/mobile**: Expo (SDK 54) + React Native 0.81 + expo-router (~6.0).
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
- Result: `pnpm --filter @wpt/mobile exec tsc --noEmit` → **0 errors** (was 3).
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

### WEB linking migration — browser-owned token, single backend authority (VERIFIED, uncommitted)

The Web link protocol was re-architected to the user's explicit contract (browser generates the token,
the server never mints; **no separate Express/Socket.IO server for QR**; the server PUSHES the login over
the Web's existing live connection; no normal-link polling; one Express/Socket.IO server). The earlier
"backend mints, browser claims" design is SUPERSEDED. Linking is **backend-only**; the chat relay is
**chat-only**.

**Flow:** browser `crypto.getRandomValues` 32B -> 64 hex -> ed25519 public identity ->
`POST /api/link/register` (BFF) -> backend stores the **hash only** -> QR rendered in the browser
(npm `qrcode`, `wpt://link/<token>`) -> one live channel on the existing backend Socket.IO namespace
(`wpt-link` ticket, room `link:<id>`) -> phone approves -> backend **pushes** `{code, expiresAt,
linkExpiresAt}` (`WEB_LINK_EVENTS.login` = `webLinkLogin`) -> `POST /api/link/redeem` (BFF) ->
server-to-server exchange -> **HttpOnly cookie**. The browser never sees a session credential.
No `mint()`, no `claim`, no poll.

- **`packages/shared/src/web-link.ts`** — rewritten: `isWebLinkToken`, `webLinkQrPayload`/
  `parseWebLinkQrPayload`, `WebLinkIdentityBundle`, `WEB_LINK_EVENTS.login`, `WEB_LINK_TTL_MS` 60s,
  link (`wpt-link`) vs realtime (`wpt-realtime`) ticket audiences, `WEB_LINK_API` = register/redeem.
- **`packages/api-client/src/web-link.ts`** — `register()`/`redeemLink()` (mint/claim deleted).
- **`packages/api-client/src/socket.ts`** — `createRealtimeClient({ticket | linkTicket | getAuthToken})`;
  a link ticket rides a single-scope handshake, never as a long-lived JWT.
- **Backend authority** — `web-link/{core,store,service,ticket,socket-registry}.ts` +
  `routes/web-link.ts` + `index.ts`. Duplicate/expired/already-used -> **410**; malformed -> **400**;
  unauthorized -> **401**. `createExclusiveSession` revokes prior WEB sessions and pushes
  `webForceLoggedOut` atomically; phone sessions untouched. Store is `MemoryWebLinkStore`.
- **Web half** — `app/lib/web-link-{client,token,server,qr}.ts`, `app/api/link/{register,redeem}/route.ts`,
  `app/wpt/qr-gate.tsx`. `web-link-token.ts` is deliberately **import-free** so the harness can execute
  the real generator; the private key stays in page memory.
- **Chat relay** — `server/wpt-server.mjs` lost `/api/link/new`, `GET /api/link/:token`,
  `/api/link/:token/confirm`, `/api/mock/qr-sessions`, the `qr:<token>` room + `qrSession` handshake, the
  `/phone/link/:token` demo page, the QR PNG generator, `makeQr/activeQr/findQr/publicOrigin` and the
  `QRCode` import. It keeps the whole chat contract (`/api/messages/*`, `/api/synced-contacts`,
  `/api/session/*`, `web:<token>` rooms, `/api/mock/new-phone-login`, `webForceLoggedOut`); its
  `webSessions` map is the CHAT mock's store, not a second link implementation. The `qrcode` dep stays —
  `app/lib/web-link-qr.ts` renders client-side.
- **Config is one switch** — `API_BASE_URL` only (three legacy names removed from
  `web-link-server.ts`). `NEXT_PUBLIC_API_BASE_URL` is optional (browser-visible realtime origin);
  `NEXT_PUBLIC_WPT_API_URL`/`WPT_RELAY_URL` remain CHAT-relay vars. `.env.example` rewritten.

**Two sockets by design, not duplication:** the LINK channel is the backend's existing Socket.IO
namespace (no new server); the CHAT socket is the pre-existing raw-WS relay. `source-lint.js` and
`web-22` assert the chat path stays Socket.IO-free — neither rule was relaxed (the one violation was
fixed by rewording a comment, not by loosening the lint).

**Channel-loss semantics** (`openLinkChannel`): a server-initiated close (`io server disconnect`, i.e. a
refused ticket) is terminal and reported at once; a first connection that hasn't landed gets a 5s grace
(`CHANNEL_CONNECT_GRACE_MS`) before `onChannelLost`, so a hiccup cannot destroy a QR the user is about to
scan. `startCycle` carries a cycle number: a superseded cycle never installs/listens/closes the live
channel (it closes its own), and an unmounted gate cannot install anything.

**Verification (all green):**
- `pnpm --filter @wpt/backend run verify:weblink` -> **136/136** (real store + router + socket registry
  over autonomous HTTP; includes the store-aware `getWebLinkService` re-resolution checks).
- `apps/web/scripts/web-link-verify.js` (replaces the deleted `web-qr13-verify.js`) -> **78/78**: the real
  `generateWebLinkToken` executed 2000x with `Math.random` booby-trapped, plus registration-before-QR,
  no-poll (the only `setInterval` is the expiry countdown, asserted to perform no request), cookie-only
  redemption, retired routes absent, relay link-protocol absent, QR payload matching
  `apps/mobile/lib/web-link.ts`. Source assertions run comment-stripped, since the comments deliberately
  name the forbidden things.
- `pnpm --filter @wpt/web run verify` -> **538/538** (78+30+22+34+31+29+19+33+87+89+37+49).
- `web-e2e.js` now starts from a linked chat session via the relay's `/api/mock/link-web` fixture.
- `pnpm turbo run lint` **6/6**, `pnpm turbo run typecheck` **5/5**, `pnpm --filter @wpt/web build`
  compiles; its route table lists only `/api/link/{redeem,register}`.
- NOTE: `@wpt/shared` / `@wpt/api-client` / `@wpt/crypto` package entries are TS-source-only with
  Node-ESM `.js` specifiers, so a bare-`node` harness CANNOT import them (next.config aliases `.js`->`.ts`
  for webpack; the mobile/backend harnesses use tsx). A web harness must import leaf `.ts` files, which
  is why the token generator lives in its own import-free module.

**Not verified:** no physical phone scan, and no live browser<->Socket.IO handshake against a running
backend (the push is proven server-side; the client wiring statically). Backend persistence is in-memory.

### WEB 2.6 — Mobile-parity UI redesign of the Web client (VERIFIED, uncommitted)

`apps/web` restyled into a clean, responsive DESKTOP version of the Sealine Mobile UI. Behavior is
unchanged; this is presentation + accessibility only. No backend/shared/protocol file was touched.

- **Icon system** — `apps/web/app/wpt/icons.tsx` (NEW) renders inline SVG from the SAME family the
  mobile app uses (`ionicons`, added to `apps/web/package.json` via `pnpm --filter @wpt/web add
  ionicons`): per-icon named imports (tree-shaken), the packaged `data:` SVG decoded and parsed into
  path/basic shapes, `currentColor` + `fill:none` stroke width, `size` + `className`, decorative
  (`aria-hidden`) by default with an optional accessible `title`.
  - **The file MUST NOT be named `icon.tsx`**: `icon` is a reserved Next.js App Router metadata
  convention, so `app/wpt/icon.tsx` was picked up as a route and the build failed with
    `Default export is missing in app/wpt/icon.tsx`. It is `icons.tsx` for that reason — do not rename.
  - Every UI dingbat/emoji in `chat-app.tsx` (`✎ ⚙ 🔍 ⓘ 📎 🎤 ➤ ✕ ↑ ↓ ▶ ❚❚ ← ›`) and the QR-gate
    `✓` is now an Ionicons `<Icon>`. The `→` arrows in qr-gate PROSE are intentional typography and
    stay.
- **Visual language ported from mobile** (`apps/mobile/lib/theme.ts`, `constants/typography.ts`):
  dark bg `#0B0F14` / accent `#3FC6B8`, light accent `#0E8A7E`, outgoing bubble = accent + dark ink,
  incoming `#2C2C2E`, bubble radius `16px` with `4px` sender-side corner, `--r-md` `12px` fields,
  `--r-sm` `10px` controls, hairline borders, restrained motion. `apps/web/app/globals.css` was
  rewritten around that token set (light/dark, focus rings, `prefers-reduced-motion`,
  `forced-colors`, Lato scale, responsive sidebar/thread/panel breakpoints).
  - `layout.tsx` now loads `family=Lato:wght@400;700;900` + `family=IBM+Plex+Mono:wght@400;500`
    (raw Google `<link>`, as before — NOT `next/font`).
  - `.st-profile`/`.ch-row` avatars now use the shared `.avatar` class with a deterministic hue from
    `avatarBg(seed)` instead of a hardcoded gradient, so Web and phone agree per user.
- **Accessibility** — `<aside aria-label="Chats">` / `<main>` landmarks, `h2` thread title, `role="log"`
  + `aria-live` on the transcript, `role="search"` on in-chat search, `aria-current` on the active
  chat row, `aria-pressed` on theme segments, `aria-expanded` on toggles, `sr-only` text on icon-only
  controls, `role="dialog"` + `aria-modal` + `aria-labelledby` on the panel and the log-off modal,
  programmatic focus into the panel with focus restore on close, and Escape closes modal-then-panel.
  - `StatusTick` now uses `<Icon>` (`alert` for the retryable failed state, `check`/`checkmarkDone`
    otherwise) and collapsed the two previously duplicated inline alert SVGs into one branch; the
    "Failed to send — tap to retry" affordance is unchanged.
- **Dead UI removed** — the Settings rows for Notifications / Help centre / Terms / Privacy were
  buttons with no handler (they promised unavailable behavior). Only working rows remain: Theme,
  This device, Blocked contacts, and the log-off button. `Blocked contacts` gained a lock icon +
  chevron; the required copy strings the verifier pins are untouched.
- **Verifier retargeting (intentional, 3 of 33 in `web-21-verify.js`)** — fonts now assert the Lato +
  IBM Plex Mono href/`:root` wiring; the brand teal asserts `#3fc6b8`/`#0e8a7e`; the composer check
  asserts the `cm-btn` + `name="attach"`/`"mic"`/`"send"` + `stamp` hooks instead of the `📎` emoji.
  Nothing was weakened, and `web-app.tsx` was left untouched so the web-22/24 guarded source
  contracts still hold.
- **Verification:** web chain `538/538` (78+30+22+34+31+29+19+33+87+89+37+49) — web-21 is 33/33;
  `turbo lint` 6/6; `turbo typecheck` 5/5; `web tsc --noEmit` 0 errors; `next build` compiles and the
  route table is unchanged (only `/api/link/{redeem,register}` + the BFF relay/session routes).
  Runtime smoke: `next start` serves `/` 200 and the served CSS contains the new tokens
  (`--font-display:"Lato"`, `--font-mono:"IBM Plex Mono"`, `#3fc6b8`, `#0e8a7e`, `--bubble-own`,
  `sr-only`, `sb-search-icon`, `sg-item-lead`).
- **Still unverified:** actual visual/browser inspection at desktop/tablet/mobile widths and the
  live browser<->Socket.IO handshake (no browser automation in this environment); the physical phone
  QR scan was already outstanding before this pass.

### WEB-R1.1 — Web-Linking backend: named test triggers + required-behaviour suite (VERIFIED, uncommitted)

Task asked for a *mock* Web-linking backend with simulated phone scan/force-logout/phone-presence.
Inspection showed the linking protocol is **already real and secure** (`web-link-verify` = 136/136):
browser CSPRNG token + public identity bundle -> register (stores SHA-256(token) only) -> Socket.IO
`wpt-link` ticket / room `link:<hash(token)>` -> mobile `approve` -> backend **pushes** a single-use
redeem code -> `POST /web-link/redeem` -> `createExclusiveSession` -> HttpOnly cookie. Confirmed there
is **no** duplicate mock in `packages/api-client`/`packages/shared` and no archived QR-1.0 to restore.

**User decision: close the real gaps in the existing backend** (not a second mock), and **keep the
redeem-code push** — do NOT push access/refresh into the browser. That contradicts the task's literal
"deliver access/refresh" wording; the secure architecture wins and the deviation is intentional.

- **`apps/backend/src/web-link/test-api.ts` — NEW.** The only genuinely missing thing was *initiating*
  the phone side of a link and moving it in time. `createWebLinkTestApi` is a thin named facade over
  the real service: `createWebLinkTestClock` (injectable `now` + `advance`), `register`,
  `simulateScan` (delegates to `service.approve`), `redeem`, `sessionStatus`, `logout`,
  `simulateForceLogout` (delegates to `revokeUserWebSessions`), `simulatePhoneOffline`/`Online` via an
  injected `phonePresence` callback. No second state machine, no second store.
- **`apps/backend/src/routes/web-link.ts`** — added 3 dev-only routes **inside
  `if (process.env.NODE_ENV !== "production")`**, each delegating to the same service fns as the real
  handlers: `POST /web-link/_dev/scan`, `POST /web-link/_dev/force-logout`,
  `POST /web-link/_dev/phone-presence`. A `devOnly` middleware also 404s them if ever reached in
  production. `_dev/phone-presence` deliberately touches NO session state (R1.4: a Web session must
  survive an unreachable phone) and just reports `sessionAffected: false` — presence itself already
  lives in the chat relay (`mockPhoneStatus`, web-web14/15), so no new linking presence protocol.
- **`packages/api-client/src/web-link.ts`** — added a `dev` namespace (`simulateScan`,
  `simulateForceLogout`, `simulatePhonePresence`) + `WEB_LINK_DEV_API` paths and typed results, so a
  test can drive the triggers through the same client seam. Deliberately NOT in the shared contract:
  no screen and no package depends on them, and BE-6.1 need not implement one. `API_BASE_URL` remains
  the only switch — the calls simply stop being made against a real backend.
- **`apps/backend/src/web-link/web-r-1-1-verify.ts` — NEW**, `pnpm --filter @wpt/backend run
  verify:webr11` → **53/53 PASS**. Tests 1-8 of the task (registration, valid scan, 60s TTL, single
  use, logout, force_logout, phone offline, phone online) driven through the named API, plus:
  the scan response is asserted to contain **no** credential while the code is proven to arrive as a
  PUSH on `link:<hash(token)>`; TTL is proven by **advancing the clock** (`+1ms` inside, `+61s`
  outside) instead of sleeping; the dev routes are exercised over real HTTP on the mounted router
  (register = **201** Created, not 200); and a spawned child proves the dev routes are mounted in
  development but **not mounted at all** in production.
- Two of my own harness bugs were found and fixed: (1) the offline test re-linked the *same* account,
  which legitimately tripped the one-browser rule (R1.6) — fixed by using a second account and adding
  an explicit R1.6 block (`replaced_by_new_browser`); (2) `registerWithTicket` signs a JWT, so the
  harness must set `JWT_SECRET` before mounting the router.
- **Not verified:** no physical phone QR scan, no live browser<->Socket.IO handshake, and backend
  persistence is still `MemoryWebLinkStore`. The pushes are proven at the registry level, the client
  wiring statically.

### WEB-R1.2 — Token security: single-use fix (real cross-account defect) + required-behaviour suite (VERIFIED, uncommitted)

R1.2 was located verbatim in the backend authority, `apps/backend/src/web-link/service.ts:7`:
**"R1.2  tokens are opaque, single-use, 60s TTL — the store keeps only SHA-256"**. Opacity, the 60s TTL and
hash-only storage were already implemented and covered. **Single-use was not**, and the gap was exploitable.

**The defect.** `MemoryWebLinkStore.createLinkIfAbsent` treated only `status === "claimed"` as spent, so a
token that had been **approved** (code minted + PUSHED) but not yet redeemed could be re-registered once
its TTL lapsed. Because `registerLinkSocket` never removes a browser from `link:<hash(token)>` on expiry
(`socket-registry.ts:67-75`), anyone who had merely *seen* the QR could re-register the hash, approve it
with their own phone, and have the new code delivered into the **original browser's still-joined room** — a
cross-account hand-off. Re-registration also replaced the record, dropping the victim's own pending code so
it could never be redeemed (silent link-break). Secondary defect: the same branch read `Date.now()` directly
while every other R1.2 decision uses the injected `now`, so the rule was untestable and clock-inconsistent.

- **`apps/backend/src/web-link/core.ts`** — NEW pure `canReregisterToken(link, now)`: the rule is now stated
  once. `approved`/`claimed` → permanently dead; live `registered` → refuse; expired-while-`registered` →
  admit (the only legitimate retry, since nothing was ever pushed). Erasable-syntax only, Node-importable.
- **`apps/backend/src/web-link/store.ts`** — `createLinkIfAbsent(link, now: Date)` now takes the injected
  clock and delegates to the predicate; the wall-clock read is gone. Interface doc records the ATOMICITY
  requirement a future DB store must honour (`ON CONFLICT … WHERE status='registered' AND expires_at<=$now`)
  so two concurrent registrations cannot both be admitted.
- **`apps/backend/src/web-link/service.ts`** — passes `now` to the store. Record shape, error codes and
  protocol unchanged.
- **`apps/backend/src/web-link/test-api.ts`** — added `validate` (the phone's pre-approval read; a pure
  delegation, needed by the R1.2 TTL-boundary checks).
- **`apps/backend/src/web-link/web-link-verify.ts`** — the 136-check suite asserted the OLD behaviour
  ("a dead token may be registered again by its owner" used a **claimed** token). That expectation *was* the
  vulnerability, so it was replaced with 3 checks (claimed dead, stays dead after TTL, unused-expired still
  retryable) → 138 checks. This was a deliberate test-expectation change, not a weakening.
- **`apps/backend/src/web-link/web-r-1-2-verify.ts` — NEW**, `pnpm --filter @wpt/backend run
  verify:webr12` → **52/52 PASS** in four sections: A Opaque (64-hex CSPRNG, 5000 distinct draws, leading
  bytes not a packed timestamp, QR = token and nothing else); B Single-use (live/approved/claimed all refuse
  re-registration, approved stays dead after TTL, code spends once, plus the cross-account push shut —
  "NO second code is ever pushed into the original browser's room"); C 60s TTL (exact boundary: `+59_999ms`
  validates, `+60_000ms` is expired/inclusive, code TTL independent, and the injected-clock regression
  guard); D Hash-only (whole-store JSON sweep finds no raw token/code/credential but does contain all three
  digests — "not simply empty").
- **Client impact: none.** `qr-gate.tsx` mints a *fresh* token on expiry ("A fresh token is the only correct
  response - never a re-poll"), so the Web never re-registered an old token.
- **Verification:** weblink 138/138, webr11 53/53, webr12 52/52, web 538/538 (12 suites), backend
  `tsc --noEmit` 0, eslint clean on all 6 touched files, `turbo lint` 6/6, `turbo typecheck` 5/5,
  `next build` compiles (route table unchanged).
- **Still not verified:** no physical phone QR scan, no live browser<->Socket.IO handshake, persistence is
  still `MemoryWebLinkStore` (so the atomicity clause is documented, not exercised under concurrency).

### WEB-R1.3 — Mobile-auth requirement: real cross-account approval race fixed + suite (VERIFIED, uncommitted)

Requirement located verbatim at `apps/backend/src/web-link/service.ts:8`:
**"R1.3 validate/approve require the MOBILE to be authenticated (IDOR-proof)"**. Note the
half that was already true: both routes carry `requireAuth` and `approve` takes its identity
from `res.locals.auth` (`sub`/`deviceId`), never from the body. **The IDOR half was NOT
enforced** — approval was a read-then-write, so it was exclusive only for *sequential* callers.

**The defect (demonstrated, not theoretical).** `approve` did `resolveUsable` → status check →
`store.updateLink`. Two mobiles that both observe `registered` both write. Proven by running the
new suite against the exact pre-fix code: **3/3 concurrent approvals returned `ok:true`, 3 separate
redemption codes were PUSHED into the same `link:<hash(token)>` room, and the only redeemable
one belonged to whichever account wrote last.** The browser that scanned the QR could be handed
a web session for a different account than the phone it scanned. A double-tap on one phone also
minted two codes.

- **`apps/backend/src/web-link/store.ts`** — new `claimLink(tokenHash, expected, patch)`:
  an ATOMIC compare-and-set on status, returning whether the caller won. `MemoryWebLinkStore`
  implements it (re-reads the record fresh, so it is correct under interleaving). The interface
  documents the DB obligation explicitly: one `UPDATE … WHERE token_hash=$h AND status=$expected
  RETURNING *`, false on zero rows — a read followed by an unconditional write does NOT satisfy it.
- **`apps/backend/src/web-link/service.ts`** — `approve` now CLAIMS (`registered`→`approved`) and
  only the winner mints a code and calls `emitWebLinkLogin`; losers get `already_used`, the same
  answer a sequential second approval gets. `claimLink` is the sole authority — the preceding
  status read was deleted rather than left as a redundant pre-check.
- **Same defect class in `redeem`, also fixed.** It read the link, checked the code was live,
  created the exclusive session, and only THEN wrote `claimed`. Two concurrent redeems of one
  code both proceeded: the second call to `createExclusiveSession` revoked the session the first
  had just created (one-browser rule), so the winner was handed an already-dead credential with
  no error. The claim now happens BEFORE session creation — exactly one caller can reach it, and
  it fails closed if that step throws.
- **Second (smaller) R1.3 gap fixed: `validate` contradicted `approve`.** `resolveUsable`
  rejected only `claimed`, so an `approved` link reported `valid: true` — telling a second phone
  to show an Approve button for a link that `approve` would then refuse with `already_used`.
  `resolveUsable` now admits only `isWebLinkRegistered(link)`, single-sourcing the rule so the two
  endpoints cannot disagree. `redeem`/`reissueLogin` read via `getLinkByRedeemHash`/`getLinkByHash`
  and are unaffected. Consistent with the intent already asserted in `web-link-verify.ts:233/502`
  and `web-r-1-2-verify.ts:213` ("a CLAIMED token is permanently dead").
- **`packages/shared/src/web-link.ts`** — comment-only fix. It mis-cited the 60s TTL as R1.3
  (the authority assigns TTL to R1.2 and auth/IDOR to R1.3); corrected and cross-referenced
  `service.ts` as the authority. **No type or wire change.** `apps/web/README.md` still has
  stale "chain R1.3-R1.8" suite naming, left alone.
- **`apps/backend/src/web-link/web-r-1-3-verify.ts` — NEW, `verify:webr13` -> 51/51 PASS**, in
  three sections: (A) authenticated, exercised **over the mounted Express router** because the
  middleware is the thing under test — no header / empty / garbage / tampered / expired /
  wrong-issuer all 401 on both endpoints; a valid mobile JWT 200s; `validate` proven a pure read;
  identity proven to come from the JWT when a body forges `mobileUserId`+`deviceId`. Also proves a
  **browser-side credential can never approve**: a `wpt-link` ticket, a `wpt-realtime` ticket and
  an opaque web-session token are all rejected as Bearer (they lack the `sid`/`deviceId` claims
  `toAccessTokenPayload` requires). (B) the exclusivity matrix: second account refused, link not
  rebound, 3 concurrent approvals → exactly 1 winner + 2 clean `already_used`, exactly 1 code
  pushed, the redeemable session belongs to the winner; 3 concurrent redeems of one code → exactly
  1 session and 1 active web session (one-browser rule intact) with the loser receiving a rejection
  rather than a dead credential; `claimLink` unit-checked across all statuses. (C) the review
  matrix: expired, approved, claimed, duplicate double-tap, old-vs-new browser, `force_logout`
  (replaying the code does not resurrect the session), and a disconnected socket (push is
  room-addressed, code stays spendable, reconnect gets a fresh code via `reissueLogin`).
- **Verification:** the suite was proven meaningful by re-running it against the exact pre-fix
  `approve` — 6 checks fail with `winners:3, losers:0` and `pushed:3`, then 51/51 after restoring
  the atomic claim. Regressions green: weblink 138/138, webr11 53/53, webr12 52/52, be55 53/53,
  web 538/538 (12 suites), backend `tsc --noEmit` 0, eslint clean, `turbo lint` 6/6,
  `turbo typecheck` 5/5, `next build` compiles (route table unchanged).
- **Not fixed here (out of scope, reported):** `requireAuth` verifies JWT
  signature/expiry/issuer but does not look up `sid` in the sessions table, so a phone JWT stays
  usable after logout/force_logout until it expires. That is global auth behaviour affecting
  every authenticated route, not a web-link defect, and changing it was explicitly avoided.
- **Still not verified:** no physical phone QR scan, no live browser<->Socket.IO handshake, and the
  store is still `MemoryWebLinkStore`, so `claimLink`'s cross-process/DB atomicity clause is
  documented and unit-tested in-process but not exercised against a real database.

### WEB-R1.4 - Approval binds account + registered browser key (core HELD; reconnect race fixed + suite) (VERIFIED, uncommitted)

Authoritative source is `apps/backend/src/web-link/service.ts:9` — **"R1.4  approval binds the
account + the browser's registered public key"** — reinforced by the `approve` contract at
`service.ts:200-206`: the approver identity comes ONLY from the authenticated mobile JWT (never a
body field) and the browser public key comes ONLY from the registration record (never the approval
request), so neither side can impersonate the other.

**Numbering conflict (deliberately NOT renumbered).** `test-api.ts:180` and `routes/web-link.ts:327`
call phone-offline/session-survival behavior "R1.4", and `apps/web/scripts/web-web14-verify.js` /
`web-web14-live.js` use the same label for an independent client suite. `apps/web/README.md` likewise
treats R1.3-R1.8 as Web suite names. `service.ts` is the established backend authority, so its
numbering wins and the client-side scripts are left alone. Do not "fix" this by editing the client.

**The core binding was already correct — proven, not assumed.** A throwaway probe (run, then deleted)
confirmed end to end that the link's `identity.publicKey` is the registered key verbatim, its
`webDeviceId` is DERIVED from that key, the link records the JWT's `approvedByUserId`/
`approvedByDeviceId`, and the resulting session's `userId`/`publicKey`/`deviceId` are the approving
account + registered key. A fully hostile approve body (`publicKey`, `identity`, `webDeviceId`,
`userId`, `deviceId`, `accountName` all forged) changed nothing but the display name.

**Two real defects found and fixed, both atomicity (TOCTOU) in the reconnect re-issue path.**

1. **`reissueLogin` was read-check-write.** Three concurrent reconnects all observed the same live
   code, all minted, all returned a code — but only the last write survived, so the browser held 3
   codes of which 2 were already dead. Fixed with a new `WebLinkStore.rotateRedeemCode(
   tokenHash, expected: { status: "approved"; codeHash }, patch)` CAS.
2. **The CAS was NOT complete on the first attempt — the suite caught it.** Redemption deliberately
   LEAVES the old code hash on the record, so a code-only CAS still succeeded against an
   already-`claimed` link, handing the browser a freshly minted code that could never be redeemed.
   Symmetrically, `redeem`'s existing status-only `claimLink` let a SUPERSEDED code buy a session when
   a rotation landed first. Both sides now CAS on `(status, codeHash)`, making re-issue and redemption
   genuinely mutually exclusive: exactly one wins, and a returned code is never dead.
   - `store.ts` — `rotateRedeemCode` added; `claimLink` gained an optional `expectedCodeHash`
     (approval passes nothing, since a link being approved has no code yet). `applyLinkPatch` factored
     out so `updateLink`/`claimLink`/`rotateRedeemCode` all maintain the redeem index identically.
   - `service.ts` — `reissueLogin` rotates via CAS and returns `null` when it loses; `redeem`'s burn
     passes the code hash it presented. Wire protocol, error codes and record shape unchanged.
   - DB atomicity clause is documented for BOTH primitives on the interface
     (`... AND status='approved' AND redeem_code_hash=$code RETURNING *`, false on zero rows).
   - `reissueLogin` remains unreachable except from the ticket-authorized socket join
     (`index.ts:151`); there is still no unauthenticated HTTP route to it.

**Verification.** `apps/backend/src/web-link/web-r-1-4-verify.ts` — NEW, `verify:webr14` -> **65/65
PASS** in five sections: (A) the binding recorded and derived correctly; (B) identity cannot be
spoofed — hostile-body approval, JWT-vs-body account/device, and the same over the **mounted Express
router** so `requireAuth` is genuinely exercised, plus forged-key/identity/device, mixed
authenticated accounts on one link, and the "browser credential can never approve" matrix;
(C1) 3 concurrent approvals -> exactly 1 winner + 1 push; (C2) 3 concurrent reconnects -> exactly 1
fresh code, superseded code out of the index and unspendable; (C2b) **25 repeated re-issue-vs-redeem
races** asserting mutual exclusion, final-status agreement, never-a-dead-code, session-count
agreement, and that the binding survives; (C3) expiry/replay/browser-replacement/logout/force_logout.
   - **Both fixes proven meaningful by sabotage, not asserted:** reverting `reissueLogin` to the
     non-atomic write fails 3 checks (`winners:3`); making redeem's claim status-only again fails 2
     checks with **`bothSucceeded: 25/25` and `deadCodeHandedOut: 25/25`**. Both saboteases restored,
     no probe/backup files left behind.
- **Regressions green:** weblink 138/138, webr11 53/53, webr12 52/52, webr13 51/51, **webr14 65/65**,
  be55 53/53, web 538/538 (12 suites), backend `tsc --noEmit` 0 + eslint 0, `turbo lint` 6/6,
  `turbo typecheck` 5/5, `next build` compiles with the route table unchanged.
- **Left as-is deliberately, and reported rather than silently changed:**
  - `ApproveInput.accountName` is body-sourced and persisted onto link/session. It is display
    metadata, not the authoritative account binding (which is `userId`, proven JWT-derived above).
    Making it authoritative needs a trusted account source or a wire change, so it was not touched.
  - The stale-JWT/session-table gap from R1.3 (out of scope, global auth behavior) is unchanged.
- **Still not verified:** no physical phone QR scan, no live browser<->Socket.IO handshake, and the
  store is still `MemoryWebLinkStore` — both CAS clauses are documented and exercised in-process but
  NOT against a real database, so cross-process atomicity remains unproven.

### WEB-R1.9 - New-phone login revokes every Web session immediately (atomic sweep + 2 auth defects fixed) (VERIFIED, uncommitted)

Authority resolved verbatim at `apps/backend/src/web-link/service.ts:17`:
**"R1.9 new-phone login revokes every Web session immediately (no grace)"** - the operation is
`revokeUserWebSessions` (service.ts:520). Three clauses: a new-phone login, **every** Web session
of the account, **immediately with no grace**.

**Numbering conflicts (left alone, per the R1.1-R1.8 precedent that `service.ts` is the
numbering authority):** `apps/web/scripts/web-web17-verify.js:1,18` and
`apps/web/server/wpt-server.mjs:155` both label this same behaviour "WEB-R1.8" - a client-suite
naming axis, not a backend claim. `apps/backend/src/routes/onboarding.ts:160` said "R1.8" for
the sweep itself; that one IS the R1.9 path and was corrected to R1.9.

**Three real defects found, all reproduced before fixing:**

1. **THE RACE (the requirement itself).** `revokeUserWebSessions` was read-then-write:
   `listSessionsByUser()` then a per-row `updateSession()` loop. A throwaway probe (run, then
   deleted) drove a browser replacement into the enumeration await and, against the UNMODIFIED
   code, left a session **LIVE** after the new-phone login reported success - that window IS the
   forbidden "grace period". It also reported `revokedCount: 1` while revoking 0 live sessions,
   and pushed the cutoff twice into the dead row's room while the survivor was never told.
   - Fix: `store.revokeAllActiveSessions(userId, revokedAt)` (store.ts) - ONE indivisible sweep
     returning only the rows it actually ended. Service is now a single store call. Contract
     documented as `ATOMICITY CONTRACT (R1.9)` with all THREE obligations a DB port must honour:
     **COMPLETENESS** (`UPDATE web_sessions SET revoked_at=$now WHERE user_id=$1 AND revoked_at
     IS NULL RETURNING *`), **EXACTNESS** (never re-revoke/re-count/re-notify a dead row, never
     stamp an expired one), and **NO AWAIT POINT** (the whole difference from the loop it
     replaces). The memory impl has no `await` inside the loop - asserted.
2. **IDOR + missing auth on R1.9's only HTTP surface.** `POST /web-link/_dev/force-logout` took
   `userId` from the **request body** and carried **no `requireAuth` at all**. Any logged-in
   phone could end every linked browser of any account it named, and any *unauthenticated*
   caller could do the same (`devOnly` does not help - development builds are who you talk to).
   Fixed to R1.3/R1.4's rule: `requireAuth` + `userId` from `res.locals.auth!.sub`, never the
   body. `reason` stays body-sourced (notice text / QA knob, same reasoning as R1.4's
   `accountName`).
3. **Expiry was being backfilled as revocation (R1.8 violation, pre-existing).** The sweep
   stamped `revokedAt` onto rows that had merely aged past `expiresAt`, making a natural expiry
   indistinguishable from a user-requested logout - exactly what R1.8's revoked/expired
   distinction forbids. The sweep now skips lapsed rows (`expiresAt <= revokedAt`; the stamp
   doubles as the server's `now`, so no clock is threaded in).

**Suite** - `web-r-1-9-verify.ts`, `verify:webr19` -> **80 passed, 0 failed** (A requirement /
B no-grace / C server-decision / D exactness / E second login / F phone survival / G account
isolation / H the race / I router / J push-is-only-a-prompt / K expiry+regression / L structural).
Section H carries a permanent **control** that reimplements the pre-fix read-then-write shape
through the same service and shows it leaving a session live, so the suite is meaningful by
construction. H1's 25 probabilistic sweep/replacement rounds did NOT catch a reverted service -
the deterministic guards for that class are H2's control and L's shape assertions.
- **Deliberate test-expectation updates** (real behaviour changed, not weakened): `webr18`
  section I pinned the R1.9 sweep to `updateSession` (now 2 such paths, not 3, plus two new
  assertions for the atomic sweep); `webr11`'s force-logout trigger test now sends a phone JWT
  and gained a 401-when-anonymous check.
- **Sabotage, by temporary edit then restore:** drop the already-revoked guard -> 10 fail (D/G/L
  over-count and corpse-notification); drop the expiry guard -> 2 fail (K); revert the service to
  read-then-write -> 8 fail (B no-grace, L shape). No probes/backups/markers left behind.
- **Verification:** R1.9 80/80, weblink 138, R1.1 54, R1.2 52, R1.3 51, R1.4 65, R1.5 72, R1.6 72,
  R1.7 75, R1.8 125, BE-5.5 53 = **837 passed, 0 failed**; web **538**; backend `tsc --noEmit` 0;
  eslint clean on all 9 touched files; `turbo lint` 6/6; `turbo typecheck` 5/5; `next build`
  compiles, route table unchanged (only `/api/link/{redeem,register}`).
- **Still not verified:** the atomicity clauses are documented and exercised in-process but NOT
  against a real database (store is still `MemoryWebLinkStore`), so cross-process atomicity is
  unproven. No physical phone scan, no live browser<->Socket.IO handshake.
- **Shared contract changed: NO** (L asserts `packages/shared` still declares no R1.9-only event
  or route). `emitWebForceLoggedOut` still has no caller, and deliberately so: addressing by
  userId would also reach a session the sweep did NOT revoke, telling a browser to drop a
  credential the server never ended. The sweep notifies exactly the rows it ended.

## WEB-DEV-LOGIN — scannable dev-only QR for the test account (VERIFIED, uncommitted)

The production QR is `wpt://link/<token>`, which only the Sealine app can open, so exercising the
funnel during development needed a physical phone in front of the screen every time. The Web QR
screen now carries a SECOND, clearly subordinate code that any scanner opens:
`http://<lan-host>:<port>/dev/test-login?phone=9876543210`. The real QR is never replaced, and the
block is gated on `process.env.NODE_ENV !== "production"` so it compiles out of a build.

- **`apps/web/app/lib/dev-test-login.ts` — NEW**, pure + dependency-free: `DEV_TEST_LOGIN_PATH`,
  `DEV_TEST_PHONES` (exactly one entry: `digits` `9876543210`, `e164` `+919876543210`, display
  `label` — **phone numbers only, no userId and no account name**), `DEV_TEST_DEVICE_ID`,
  `normalizeDevPhone`, `devTestPhone` (digits-only key OR the entry's own declared `e164` in
  `+`/`00` form — no "last 10 digits" fallback), `isDevTestPhone`, `devTestPhoneList`,
  `devTestLoginAllowed` (`!== "production"`), `isLoopbackHost`, `resolveDevQrOrigin`
  (`NEXT_PUBLIC_DEV_QR_ORIGIN` wins, else the page origin; loopback/malformed/non-http rejected),
  `buildDevTestLoginUrl`, `devQrUnavailableReason`.
- **Identity comes from the backend account store, never from the client (supersedes the earlier
  hard-coded test user).** `_dev/scan` used to be handed a `userId`/`accountName` by the Web client,
  which made the flow only *reproducible* rather than real — body-trusted identity is exactly what
  R1.3 forbids everywhere else. Now the Web client sends **only** the E.164 phone, and
  `apps/backend/src/accounts/account-lookup.ts` resolves it against the authoritative
  `users.phone_number` (E.164, unique) -> `id` + `name`, i.e. the same lookup OTP verify performs.
  Unknown number -> `404 account_not_found`, malformed -> `400 invalid_phone`, and there is **no
  fallback account and no name synthesis** (creating accounts is OTP verify's job). The module sits
  outside `src/web-link` deliberately: R1.7's structural guard forbids `src/db`/`drizzle` imports in
  the linking protocol, and it is load-bearing — the same split `src/messages/providers.ts` uses.
  `overrideAccountLookup`/`resetAccountLookup` are the test-only seam (same pattern as the realtime
  provider bottle).
- **`apps/web/app/dev/test-login/route.ts` — REWRITTEN.** It previously dialled the realtime link
  channel purely to be pushed the code, and died with `[dev/test-login] failed: the realtime link
  channel did not come up` (GET 502) for reasons unrelated to whether the flow works. Now:
  dev-mode gate (404 in production, reached before any protocol code) -> allowlist -> register via
  `webLinkApi().register` with the one CSPRNG token module -> the backend's own `_dev/scan` trigger
  with `phoneNumber: entry.e164` + `deliverInline: true` -> `redeemLink` -> `setSessionCookie` ->
  redirect. Display name comes from the redeemed session (`redeemed.accountName`), falling back to
  the E.164. The identity bundle is built from `@wpt/crypto` directly, so the realtime client is not
  even in the module graph — the "no socket" claim is structural, not merely a missing call. Nothing
  bypassed: the code is still minted by the atomic `approve`, the session by the atomic `redeem`
  (one-browser rule still runs), and the credential still only lands in an HttpOnly cookie.
- **Backend opt-in inline delivery** — `_dev/scan` accepts `deliverInline`; the DEFAULT response is
  still credential-free and production `/web-link/:token/approve` never returns a code.
  `approve()`'s result now carries `code`/`codeExpiresAt`/`linkExpiresAt` for that one caller.
  `api-client`'s `dev.simulateScan` gained the optional input + optional result fields.
- **LAN** — `dev` binds `0.0.0.0`; `start` was deliberately left as plain `next start`, because the
  LAN-wide dev QR only exists under `next dev` and binding production to every interface would widen
  the app's surface for no benefit. `next.config.js` gained `allowedDevOrigins` for private
  ranges + `*.local`; `.env.example` documents `NEXT_PUBLIC_DEV_QR_ORIGIN` commented out. No LAN
  address is committed anywhere (asserted by scanning all shipped source, comments stripped).
- **`apps/web/scripts/web-dev-login-verify.js` — NEW, 133/133 PASS**, second in the `verify` chain.
  A pure-contract sweep, the QR screen's additive/dev-only wiring, the route's gate + protocol +
  "no socket anywhere in the graph", production-untouched assertions, LAN config, the 401 mapping
  invariant, and a section G that pins the **no-hard-coded-identity** contract (no `userId`/
  `accountName` anywhere in the allowlist/route/scan body, and the backend resolver must read the
  account store). Backend `verify:webr11` grew to **87/87** (deliverInline matrix over real HTTP,
  the behavioural 401 matrix, and the mounted-router phone-resolution matrix).
- **Verified by actually running it**, not just by source assertions: a temporary probe (run, then
  deleted) booted the real backend router + `next dev` and drove the route over HTTP — wrong phone
  400/no cookie, no phone 400, good phone 200 + `HttpOnly` cookie, and `/api/session/status` with it
  returned `linked:true` with the **account-store's** `userId`/name, no cookie `no_session`, and the
  first cookie `not_authorized` after a second login (R1.6 intact). No identity string from the
  fixture appeared anywhere in the response body. In `next start` (production): `/dev/test-login`
  404 with no cookie for both phone forms, and the dev block was absent from `/` (200, no
  `9876543210` in the HTML).
- **Anti-regression by sabotage:** making `_dev/scan` prefer the body `mobileUserId` over the
  resolved phone fails the R1.1 identity checks; adding a literal `userId` to the Web allowlist fails
  4 dev-login checks. Both saboteases were restored.
- **Real bug found and fixed by that run** — `packages/api-client`'s `unwrap` let the response
  body's domain code win over the HTTP status, so its own `401 -> not_authorized` branch was
  unreachable for every code the backend actually sends (`WEB_SESSION_INVALID`,
  `MISSING_WEB_SESSION`, …). A revoked session was reported as `reason:"unreachable"` — the exact
  opposite of what `app/api/session/status` documents, stranding a user who had been replaced with
  a connectivity error. 401 is now decided by status first (410/429 keep their own meanings).
  Proven meaningful by sabotage: `status === 999` fails 5 backend checks + 1 web check with the
  original symptom, 87/87 + 133/133 after restore.
- **Not verified:** the real-DB *read* could not be observed — drizzle builds the expected
  `select "id","name" from "users" where "users"."phone_number" = $1 limit 1`, and the host is
  reachable, but the credentials in `apps/backend/.env` fail authentication (pre-existing
  environment issue, not touched here). So the wiring is proven over real HTTP with the account seam
  injected, and the live SQL is proven to be issued but not to return a row. Also no physical phone
  scan of the LAN URL (no camera/device here), and no visual browser inspection at
  1440/1280/1024/mobile. The CSS is fluid (152px code, `overflow-wrap: anywhere` URL, inside
  `.gate-code` which is already `100%/max-width:360px` under 719px) but that is reasoning, not a
  screenshot.

## Conventions

### WEB-R1.4/R1.5/R1.6/R1.8 + qr-login (HISTORICAL — component deleted)

Those requirements were first delivered on pps/web/qr-login (an Express + Socket.io demo) and are
SUPERSEDED. pps/web/qr-login/ was deleted only after the @wpt/web Next.js client
(pps/web/app) re-implemented the whole funnel end to end and passed the migrated
harnesses. Do NOT read the old architecture from this tombstone: that era stored the
session webToken in localStorage and validated it at /api/session/validate/:webToken.
The CURRENT architecture is the HttpOnly wpt_web_session cookie validated against
pps/backend by the BFF, with localStorage holding display identity only and short-lived
realtime tickets (see the WEB 2.x sections below).


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
- **Server** — 
egisteredNumbers Map (e164 -> userId; stand-in for the account store, same deal as the WEB-2.4
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

### WEB 2.2/2.4 verify chain � final green sweep (VERIFIED, uncommitted)

Rebalanced the two Message-Sending-Parity / Synced-Contacts verifiers that had drifted
off the post-refactor relay contract (they were asserting the OLD static-shape of the
orchestrator, before the relay-media-helper + relay-synced-contacts split):

- scripts/web-22-verify.js:107 � "media URLs are built by the relay media helper":
  pinged messages.ts directly; now asserts the bridge imports the shared relay helper
  (
elayMediaUrl + rom "./api") and that the client messages carry the media metadata.
- scripts/web-24-verify.js:131 � "orchestrator loads synced contacts via the
  session-authenticated route": now asserts the orchestrator uses SYNCED_CONTACTS_ROUTE
  + isSyncedContactsPayload instead of the obsolete token-path builder.

Verified fresh, standalone + in-series (each script self-hosts wpt-server.mjs on its own port):
web-13 20/20, web-14 30/30, web-14-live 22/22, web-15 32/32, web-16 31/31, web-17 29/29,
web-e2e 19/19, web-21 33/33, web-22 61/61, web-23 89/89, web-24 37/37, web-25 49/49 � ALL GREEN.

Note for the next session: these two verifiers are the "guarded" static source-contract
checks; when the orchestrator or the relay middleware is next refactored, re-run
`node scripts\web-22-verify.js` + `node scripts\web-24-verify.js` in-series FIRST (they
pin the current wiring). Everything else in the repo chain is unchanged from the last
verified state.

### WEB 2.2 — production authorization audit + hardening (VERIFIED, uncommitted)

Audit of the REAL production path (not just the standalone relay harness) found the chat
authorization model was client-only. All of it is fixed and covered:

- **`apps/web/app/lib/relay-identity.ts` — NEW**; pure, dependency-free (Node-importable,
  mirrors `receipts.ts`/`manual-number.ts`): `IDENTITY_POST_ROUTES`, `isIdentityPostRoute`,
  `bindPostIdentity` (403 `from_mismatch` when a body names another sender; injects the
  session user when `from` is absent; 400 `bad_json`), `bindPathIdentity` (re-binds
  `/api/messages/{uid}/{peer}` + `/api/recent-chats/{uid}` to the session user; appends the
  caller to `/api/group-messages/{gid}` + `/api/synced-contacts`).
- **`app/api/relay/[...path]/route.ts`** — the BFF now binds the backend-validated session
  onto every request (it previously injected the user for synced-contacts ONLY, leaving
  `from`/path ids client-asserted). Client-only authorization is gone: a session can no
  longer send, or read history, as another account.
- **`server/wpt-server.mjs`** — (a) `verifyRealtimeTicket()`: HS256 JWT checked with
  `node:crypto` timing-safe compare + `iss=wpt-backend`/`aud=wpt-realtime`/`ticket:true`/`exp`;
  the `join` message now presents that ticket and the relay joins `user:<ticket.sub>`, so a
  client can no longer assert a `userId` to join any user's room (closes with 4001).
  (b) `/api/group-messages/:gid` requires a caller and 403 `not_member` otherwise (any
  session could previously read any group's messages). (c) text over `MAX_TEXT_LENGTH` is
  rejected `400 message_too_long` — the silent `.slice()` truncation is GONE.
- **`app/wpt/web-app.tsx`** — mints the ticket via `POST /api/session/ticket` (existing BFF
  route, already backed by `apps/backend/src/web-link/ticket.ts`) and joins with it; a
  failed ticket retries on the 3s cadence, a 401 never loops. `mockIncomingMessage` is no
  longer handled in the production event switch (the relay knob stays for QA). Added
  `catchUpOpenThread()` on every socket open (re-fetch + re-report read for the OPEN thread,
  so messages missed while offline are not lost). `retryMessage()` re-arms the outbox for a
  failed message. Over-cap text is refused before enqueue.
- **`app/wpt/chat-app.tsx`** — failed messages are now tappable (retry) instead of a dead
  icon; over-cap text keeps the draft and shows the cap inline via the existing `.cm-err`.
- **Verification**: web-22 87/87 (was 61) — 26 new checks covering the text cap (rejected,
  at-cap intact, no truncated row), BFF identity binding (forged `from` → 403, injection,
  bad JSON, non-identity routes untouched, history/recent re-binding, caller-less read → 403)
  and ticket-authenticated join. web-15 gained the group-membership matrix (34/34). Full
  `pnpm --filter @wpt/web run verify` = **480/480** (was 413). `turbo lint 6/6`,
  `turbo typecheck 5/5`, `next build` compiled. `AGENTS.md`'s merge conflict is resolved
  (the `theirs` side was 175 lines of history for the deleted `qr-login` component).
- **Still blocked / not fixed**: media durability is in-memory in the relay (needs a
  backend), and there is NO mobile receive leg (BE-5.4 has no compatible messaging routes).

### Sprint 3 scope decision — WEB-2.4 / WEB-2.5 (user-confirmed)

The Sprint 3 spec marks WEB-2.4 (Synced Contacts) and WEB-2.5 (Manual Number Entry) BLOCKED
— WEB-2.4 on mobile PERM-2.16, WEB-2.5 downstream of it. Both were nonetheless already
implemented and green in the tree from earlier sessions (web-24 37/37, web-25 49/49).

**User decision: leave the code as-is and EXCLUDE both from the Sprint 3 report** as
out-of-scope/blocked. Do not revert them, and do not re-open the scope question. They remain
subject to their real blocker (PERM-2.16) when that sprint is scheduled.

### PERM-2.1 – 2.15 on WEB_QR — PRD fixed sequence rebuilt (VERIFIED, uncommitted)

Branch `WEB_QR` (NOT team-alpha). Its mobile app was a thin version: contextual
Contacts/Notifications screens, a broken `lib/sha256.ts` (padding sized in words, threw on
any real input), `expo-notifications`/`expo-audio` missing, sync uploading nowhere. Rebuilt to
the PRD cards (the report's PERM-2.1 decision was resolved in favour of the PRD):

- **PERM-2.1** `app/permission-info.tsx` = static 5-row explainer (`lib/permission-explainer.ts`),
  Continue is the ONLY control, no skip/toggles, back + swipe disabled. Profile Setup calls
  `permissionSequence.arm()` then routes here; `(tabs)/_layout.tsx` redirects here while the
  sequence is owed. `notifications-info.tsx` deleted.
- **PERM-2.2** `lib/permission-sequence.ts` (pure): Contacts -> Notifications -> Microphone ->
  Camera -> Photos, one single-permission call at a time, progress persisted per step in
  SecureStore `onb.permissionSequence`, resume (not restart) after interruption/kill, OEM silent
  answers and throwing modules are normal step results. `lib/permission-flow.ts` = app instance
  + on-grant side effects.
- **PERM-2.3/2.4** hash = SHA-256(**salt + E.164**) — the BACKEND formula (`utils/phone-hash.ts`);
  salt served by NEW `GET /api/v1/contacts/config`. `lib/contact-sync-core.ts` (pure) pages,
  normalizes (default country from own number), skips malformed, dedupes, 250-batches, guards
  hashes-only, reports failure. Real endpoint `POST /contacts/match` (no mock). New Chat:
  denied -> banner + no list + manual entry (one-item batch via `lookupNumber`).
- **PERM-2.5/2.6** NEW backend `push_tokens` (migration **019**), `POST /push/register|unregister`,
  `src/push/expo-push.ts` (content-free alert, `PUSH_DISABLED=1` off); `relay /send` pushes to
  devices with no live socket. Mobile `lib/push.ts` (HIGH `messages` channel before the Android 13
  dialog, Expo token -> backend). Denied: live in-app unread (`takeNewIncoming` + `unreadStore`) +
  notifications banner.
- **PERM-2.7/2.8** `components/voice-record-button.tsx` is the ONLY expo-audio recorder and is
  mounted only when the mic gate is granted (press-and-hold); otherwise Settings dialog, no recorder.
- **PERM-2.9–2.12** attach menu always offers Take photo + Choose from gallery; each path reads
  only its own permission (`lib/attach-gate.ts`); denied -> Settings dialog.
- **PERM-2.13/2.14** `hooks/use-permission-state.ts` re-reads the OS on every foreground;
  `lib/banner-dismissal.ts` is session memory only (no SecureStore).
- Verify: `pnpm --filter @wpt/mobile run verify:perm2` **113/113** (sabotage-proven),
  `pnpm --filter @wpt/backend run verify:perm2` **22/22** over HTTP, push_tokens migration on
  PGlite 4/4, mobile `tsc` + `expo lint` clean, backend `tsc` clean + eslint clean on touched files
  (backend `pnpm lint` bin shim is broken: run `node ../../node_modules/eslint/bin/eslint.js`).
- Follow-up (PERM-2.11–2.15 report pass): attach menu = Take photo / Photo or video from gallery /
  Document (`expo-document-picker` ~14.0.8); gallery + documents go through `ensurePhotosAccess()`
  only. NEW `lib/permission-monitor.ts` (pure) + `lib/permission-status.ts`: ONE app-wide monitor,
  started at boot, re-checks all five on EVERY foreground, diffs against last-known state; re-grant
  (denied/unavailable -> granted) of Contacts starts sync, of Notifications registers push.
  `usePermissionState` reads the monitor. All five denial banners: contacts (New Chat),
  notifications (Chat List), microphone/camera/photos-files (chat thread); dismissal store and
  monitor never import each other. Harness now **144/144**.
- PERM-2.15 steps 3–4 BLOCKED: the mobile chat on WEB_QR is still a local simulation (relayClient /
  socket never used to send or receive; no mobile E2E engine). A real two-account message needs the
  messaging/encryption work, not permission code.
- NOT done: migration 019 not run on Supabase; no device test (real push needs an EAS
  `projectId` + FCM/APNs creds in a dev build — Expo Go cannot receive remote push); not merged.
