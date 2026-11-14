// scripts/perm-2-verify.ts
//
// PERM-2.1 – PERM-2.15 verification harness (Node, no device).
//   node --import tsx scripts/perm-2-verify.ts
//
// Behavioural checks drive the real pure modules with fake OS dialogs and a
// fake match endpoint. Source checks (comments stripped) pin the screen
// wiring that can only be exercised on a device.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PERMISSION_ORDER,
  createPermissionSequence,
  isSequencePending,
  parseProgress,
  type PermissionKey,
  type Requesters,
  type StepOutcome,
} from '../lib/permission-sequence';
import { EXPLAINER_ITEMS } from '../lib/permission-explainer';
import { countryOf, hashContactNumber, isContactHash, normalizeToE164 } from '../lib/contact-hash';
import {
  CONTACT_BATCH_SIZE,
  assertHashesOnly,
  lookupManualNumber,
  runContactSync,
  type MatchedUser,
  type RawContact,
} from '../lib/contact-sync-core';
import { canRecordVoiceNotes, decideRecordAction, formatVoiceDuration, isUsableVoiceNote, micGateFrom } from '../lib/voice-note';
import { attachOptions, decideAttachAction } from '../lib/attach-gate';
import { dismissBanner, isBannerDismissed, resetBannerDismissals } from '../lib/banner-dismissal';
import { takeNewIncoming, unreadStore } from '../lib/unread';

const HERE = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, '..');
const BACKEND = join(MOBILE, '..', 'backend');

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
  }
}
function section(title: string) {
  console.log(`\n${title}`);
}

function src(rel: string): string {
  const raw = readFileSync(join(MOBILE, rel), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
function backendSrc(rel: string): string {
  const raw = readFileSync(join(BACKEND, rel), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function memoryStore() {
  let v: string | null = null;
  return { get: async () => v, set: async (x: string) => void (v = x), peek: () => v };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  // ───────────────────────────── PERM-2.1 ─────────────────────────────
  section('PERM-2.1  Permissions explainer screen');
  check('explainer lists exactly the five permissions', EXPLAINER_ITEMS.length === 5);
  check(
    'explainer rows follow the fixed §5.3 order',
    EXPLAINER_ITEMS.map((i) => i.key).join(',') === PERMISSION_ORDER.join(','),
  );
  check(
    'every row has a plain-language one-line reason',
    EXPLAINER_ITEMS.every((i) => i.reason.length > 10 && i.reason.length < 120 && !i.reason.includes('\n')),
  );
  const info = src('app/permission-info.tsx');
  check('no toggle / switch / checkbox on the explainer', !/\b(Switch|Checkbox|CheckBox|toggle)\b/.test(info));
  check('no Skip / Not now / Later path on the explainer', !/\b(Skip|Not now|Later)\b/.test(info));
  check(
    'exactly one actionable control (Continue)',
    (info.match(/<TouchableOpacity\b/g) ?? []).length === 1 &&
      (info.match(/<Pressable\b/g) ?? []).length === 0 &&
      /accessibilityLabel="Continue"/.test(info),
  );
  check('Continue hands off to the OS sequence (permissionSequence.run)', /onPress=\{run\}/.test(info) && /permissionSequence\.run\(\)/.test(info));
  check('the explainer itself never calls a permission API', !/request\w*Permission|requestPermission\(/.test(info));
  check('Chat List is only reached after the sequence is done', /if \(result\.stage === 'done'\) await finish\(\)/.test(info));
  check('hardware back is blocked', /hardwareBackPress', \(\) => true/.test(info));
  check(
    'iOS swipe-back is disabled for the explainer',
    /name="permission-info" options=\{\{ headerShown: false, gestureEnabled: false \}\}/.test(src('app/_layout.tsx')),
  );
  check('direct arrival without profile setup is sent away', /if \(!progress\) \{\s*router\.replace\('\/'\)/.test(info));
  const profile = src('app/profile-setup.tsx');
  check(
    'Profile Setup (ONB-1.5) arms the explainer, then routes to it',
    /await permissionSequence\.arm\(\);\s*router\.replace\('\/permission-info'\)/.test(profile),
  );
  const tabsLayout = src('app/(tabs)/_layout.tsx');
  check(
    'Chat List redirects to the explainer while the sequence is owed',
    /isSequencePending\(progress\)\) router\.replace\('\/permission-info'\)/.test(tabsLayout) && /if \(!ready\) return null/.test(tabsLayout),
  );
  check('the contextual notifications screen is gone', !existsSync(join(MOBILE, 'app/notifications-info.tsx')));
  check('no screen links to /notifications-info', !/notifications-info/.test(src('app/_layout.tsx') + info + profile));

  // ───────────────────────────── PERM-2.2 ─────────────────────────────
  section('PERM-2.2  Five sequential OS dialogs, fixed order');
  {
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;
    const mk = (outcome: (k: PermissionKey) => StepOutcome): Requesters =>
      Object.fromEntries(
        PERMISSION_ORDER.map((k) => [
          k,
          async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            log.push(k);
            await tick();
            await tick();
            active -= 1;
            return outcome(k);
          },
        ]),
      ) as Requesters;

    const store = memoryStore();
    const seq = createPermissionSequence({ requesters: mk(() => 'granted'), store });
    await seq.arm();
    const r = await seq.run();
    check('exactly 5 dialogs fire', log.length === 5, log);
    check('order is Contacts -> Notifications -> Microphone -> Camera -> Photos', log.join(',') === 'contacts,notifications,microphone,camera,photos', log);
    check('never more than one dialog in flight (no parallel / batch)', maxActive === 1, { maxActive });
    check('sequence ends in stage done', r.stage === 'done' && r.next === 5);

    log.length = 0;
    const store2 = memoryStore();
    const seq2 = createPermissionSequence({
      requesters: mk((k) => (k === 'contacts' ? 'denied' : 'granted')),
      store: store2,
    });
    await seq2.arm();
    const r2 = await seq2.run();
    check('denying the 1st still fires the 2nd (and all the rest)', log.join(',') === PERMISSION_ORDER.join(','), log);
    check('denial recorded per permission', r2.results.contacts === 'denied' && r2.results.notifications === 'granted');

    log.length = 0;
    const store3 = memoryStore();
    const seq3 = createPermissionSequence({ requesters: mk(() => 'denied'), store: store3 });
    await seq3.arm();
    const [a, b] = await Promise.all([seq3.run(), seq3.run()]);
    check('a second run() while in flight joins it (no duplicate dialogs)', log.length === 5 && a === b, log);

    // Interruption: the process dies while the Microphone dialog is showing.
    const killStore = memoryStore();
    const firstLog: string[] = [];
    const hanging: Requesters = Object.fromEntries(
      PERMISSION_ORDER.map((k) => [
        k,
        () => {
          firstLog.push(k);
          return k === 'microphone' ? new Promise<StepOutcome>(() => {}) : Promise.resolve<StepOutcome>('granted');
        },
      ]),
    ) as Requesters;
    const killed = createPermissionSequence({ requesters: hanging, store: killStore });
    await killed.arm();
    void killed.run();
    for (let i = 0; i < 10; i += 1) await tick();
    const mid = parseProgress(killStore.peek());
    check('progress is persisted after each answered step', mid?.stage === 'running' && mid.next === 2, mid);
    const resumedLog: string[] = [];
    const resumed = createPermissionSequence({
      requesters: Object.fromEntries(
        PERMISSION_ORDER.map((k) => [k, async () => (resumedLog.push(k), 'granted' as StepOutcome)]),
      ) as Requesters,
      store: killStore,
    });
    const rr = await resumed.run();
    check('after an interruption it RESUMES at Microphone, not Contacts', resumedLog.join(',') === 'microphone,camera,photos', resumedLog);
    check('resumed sequence keeps earlier answers and finishes', rr.stage === 'done' && rr.results.contacts === 'granted');

    // OEM skin answers without a dialog; a throwing module is a normal step result.
    const oemLog: string[] = [];
    const oem = createPermissionSequence({
      store: memoryStore(),
      requesters: Object.fromEntries(
        PERMISSION_ORDER.map((k) => [
          k,
          () => {
            oemLog.push(k);
            if (k === 'notifications') return Promise.resolve<StepOutcome>('denied');
            if (k === 'camera') return Promise.reject(new Error('module missing'));
            return Promise.resolve<StepOutcome>('granted');
          },
        ]),
      ) as Requesters,
    });
    await oem.arm();
    const ro = await oem.run();
    check('a silent OEM answer is a normal step result; the next one still fires', oemLog.length === 5 && ro.results.notifications === 'denied');
    check('a failing permission module is recorded as unavailable, not a crash', ro.results.camera === 'unavailable' && ro.stage === 'done');

    const doneStore = memoryStore();
    const doneSeq = createPermissionSequence({ requesters: mk(() => 'granted'), store: doneStore });
    await doneSeq.arm();
    await doneSeq.run();
    await doneSeq.arm();
    check('re-arming after completion never re-asks', parseProgress(doneStore.peek())?.stage === 'done');
    check('isSequencePending: owed vs done vs never-entered', isSequencePending({ stage: 'explainer', next: 0, results: {} }) && !isSequencePending({ stage: 'done', next: 5, results: {} }) && !isSequencePending(null));
    check('corrupt progress is rejected, not trusted', parseProgress('{"stage":"hacked","next":9}') === null && parseProgress('not json') === null);
  }
  const perms = src('lib/permissions.ts');
  check('no bulk/"request multiple" permission API anywhere', !/requestMultiple|requestPermissionsAsync\(\s*\[|Promise\.all/.test(perms + src('lib/permission-sequence.ts') + src('lib/permission-flow.ts')));
  check('each REQUESTS entry is one single-permission call', (perms.match(/requestPermissionsAsync\(\)|requestRecordingPermissionsAsync\(\)|requestCameraPermissionsAsync\(\)|requestMediaLibraryPermissionsAsync\(\)/g) ?? []).length === 5);
  check('the screen resumes on return to foreground', /AppState\.addEventListener\('change'[\s\S]*progress\?\.stage === 'running'\) void run\(\)/.test(info));

  // ───────────────────────────── PERM-2.3 ─────────────────────────────
  section('PERM-2.3  Contacts: automatic hashed sync on grant');
  {
    const { sha256 } = await import('../lib/sha256');
    const nist: [string, string][] = [
      ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
      ['The quick brown fox jumps over the lazy dog', 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'],
    ];
    check('SHA-256 matches the NIST / reference vectors', nist.every(([m, d]) => sha256(m) === d), nist.map(([m]) => sha256(m)));
    const sweep = Array.from({ length: 300 }, (_, i) => 'x'.repeat(i) + 'é€😀'.slice(0, i % 4));
    check('SHA-256 == node:crypto for lengths 0..299 incl. UTF-8 and block edges', sweep.every((m) => sha256(m) === createHash('sha256').update(m, 'utf8').digest('hex')));

    process.env.GLOBAL_SALT = 'perm23_verify_salt';
    const backendHashPath = join(BACKEND, 'src', 'utils', 'phone-hash.ts');
    const backendHash = (await import(pathToFileURL(backendHashPath).href)) as { phoneHash: (e164: string) => string };
    const salt = process.env.GLOBAL_SALT;
    const e164 = '+919876543210';
    check('mobile hash == backend contact_hashes formula SHA-256(salt + E.164)', hashContactNumber(e164, salt) === backendHash.phoneHash(e164));
    check('hash == node:crypto reference', hashContactNumber(e164, salt) === createHash('sha256').update(salt + e164).digest('hex'));
    check('hash output is 64 lowercase hex', isContactHash(hashContactNumber(e164, salt)));
    const IN = countryOf('+91 98765 43210');
    check('default country is taken from the user\'s own number', IN === 'IN');
    const variants = ['+91 98765 43210', '098765 43210', '98765-43210', '(+91) 98765 43210', '+919876543210'];
    check('normalization BEFORE hashing: all local formats -> one E.164', variants.every((v) => normalizeToE164(v, IN) === e164), variants.map((v) => normalizeToE164(v, IN)));
    check('malformed / email / empty -> skipped (null)', ['', '   ', 'abc', 'me@mail.com', '12', null as unknown as string, '+++'].every((v) => normalizeToE164(v, IN) === null));

    const book: RawContact[] = [];
    for (let i = 0; i < 1200; i += 1) {
      book.push({ phoneNumbers: [{ number: `+1 415 555 ${String(1000 + i).padStart(4, '0')}` }] });
    }
    book.push({ phoneNumbers: [{ number: '+14155551000' }] });
    book.push({ phoneNumbers: [] });
    book.push({});
    book.push({ phoneNumbers: [{ number: 'not a number' }] });
    book.push({ phoneNumbers: [{ number: null }] });
    book.push({ phoneNumbers: [{ number: 'someone@example.com' }] });
    book.push(null as unknown as RawContact);

    const sent: unknown[][] = [];
    const registered = new Map<string, MatchedUser>([
      [hashContactNumber('+14155551005', salt), { id: 'u-a', name: 'Asha', about: '' }],
      [hashContactNumber('+14155552100', salt), { id: 'u-b', name: 'Ben', about: '' }],
    ]);
    let saltCalls = 0;
    const result = await runContactSync({
      readPage: async (offset, size) => ({ data: book.slice(offset, offset + size), hasNextPage: offset + size < book.length }),
      getSalt: async () => (saltCalls++, salt),
      match: async (hashes) => {
        sent.push(hashes);
        return hashes.flatMap((h) => (registered.has(h) ? [registered.get(h)!] : []));
      },
      defaultCountry: 'US',
    });
    const all = sent.flat();
    check('sync completes on a 1,200+ contact book with malformed entries', result.status === 'completed', result);
    check('malformed / empty / null entries are skipped, not fatal', result.status === 'completed' && result.skipped === 6, result);
    check('payload contains ONLY 64-hex hashes (no raw numbers)', all.every(isContactHash) && !all.some((h) => /^\+?\d{7,15}$/.test(String(h)) || String(h).includes('+')));
    check('duplicates are removed before upload', all.length === 1200 && new Set(all).size === 1200);
    check(`batched: ${Math.ceil(1200 / CONTACT_BATCH_SIZE)} requests, each <= ${CONTACT_BATCH_SIZE} (backend cap 1000)`, sent.length === 5 && sent.every((b) => b.length <= CONTACT_BATCH_SIZE));
    check('registered users found by matching', result.status === 'completed' && result.matches.map((m) => m.id).sort().join() === 'u-a,u-b');
    check('salt fetched from the backend', saltCalls === 1);

    let n = 0;
    const broken = await runContactSync({
      readPage: async (offset, size) => ({ data: book.slice(offset, offset + size), hasNextPage: offset + size < book.length }),
      getSalt: async () => salt,
      match: async () => {
        n += 1;
        if (n === 3) throw new Error('HTTP 503');
        return [];
      },
      defaultCountry: 'US',
    });
    check('a failed upload is REPORTED (status failed + partial count), never silent', broken.status === 'failed' && broken.uploaded === 500 && broken.error === 'HTTP 503', broken);
    let blocked = false;
    try {
      assertHashesOnly(['+919876543210']);
    } catch {
      blocked = true;
    }
    check('a raw number can not pass the pre-network guard', blocked);
  }
  const sync = src('lib/contact-sync.ts');
  const flow = src('lib/permission-flow.ts');
  check('Contacts grant starts the sync automatically (no extra action)', /key === 'contacts'\) sideEffects\.contactSync = syncContactsFromDevice\(\)/.test(flow));
  check('sync talks to the real backend endpoint, not a mock', /contactsApi\.match/.test(sync) && !/mock/i.test(sync) && /\/api\/v1\/contacts/.test(src('api/contactsApi.ts')));
  check('the API client refuses non-hash input before any request', /if \(!hashes\.every\(isContactHash\)\) throw new Error\('RAW_VALUE_BLOCKED'\)/.test(src('api/contactsApi.ts')));
  check('a sync failure is surfaced to the user after the sequence', /sync\?\.status === 'failed'[\s\S]*Alert\.alert/.test(info));
  check('no debug/raw upload path exists in the sync code', !/phoneNumbers.*fetch|rawNumbers|DEBUG_RAW|sendRaw/i.test(sync + src('lib/contact-sync-core.ts')));

  // ───────────────────────────── PERM-2.4 ─────────────────────────────
  section('PERM-2.4  Contacts denied: manual entry + banner');
  {
    const salt = 'perm24_salt';
    const batches: string[][] = [];
    const deps = {
      getSalt: async () => salt,
      match: async (h: string[]) => {
        batches.push(h);
        return h[0] === hashContactNumber('+14155552671', salt) ? [{ id: 'u-x', name: 'Xia', about: '' }] : [];
      },
      defaultCountry: 'US' as const,
    };
    const hit = await lookupManualNumber('(415) 555-2671', deps);
    check('manual entry -> registered user starts a chat', hit.status === 'registered' && hit.user.id === 'u-x' && hit.e164 === '+14155552671');
    check('uses the SAME match endpoint with a ONE-item batch of a hash', batches.length === 1 && batches[0].length === 1 && isContactHash(batches[0][0]));
    const miss = await lookupManualNumber('+1 202 555 0143', deps);
    check('unregistered number -> not_registered', miss.status === 'not_registered');
    const before = batches.length;
    const bad = await lookupManualNumber('hello', deps);
    check('invalid input is rejected locally, no request sent', bad.status === 'invalid' && batches.length === before);
    const down = await lookupManualNumber('+14155552671', { ...deps, match: async () => { throw new Error('HTTP 500'); } });
    check('endpoint failure is reported, not treated as "not registered"', down.status === 'failed');
  }
  const tabs = src('app/(tabs)/index.tsx');
  check('denied branch shows the reusable banner', /!granted \? <PermissionBanner permissionId="contacts" \/>/.test(tabs));
  check('denied branch renders NO contact list', /!granted \? null :/.test(tabs));
  check('manual entry is always available in New Chat', /<ManualNumberEntry colors=\{colors\} onStart=\{pick\} \/>/.test(tabs));
  check('manual entry goes through lookupNumber (hash + match), not free text', /const result = await lookupNumber\(value\)/.test(tabs));
  check('the picker no longer requests Contacts itself', !/Contacts\.requestPermissionsAsync/.test(tabs));
  check('banner component is shared across all five permissions', /'contacts' \| 'notifications' \| 'microphone' \| 'camera' \| 'photos-files'/.test(src('components/permission-banner.tsx')));
  check('banner always carries a Settings link', /Linking\.openSettings\(\)/.test(src('components/permission-banner.tsx')));

  // ───────────────────────────── PERM-2.5 / 2.6 ─────────────────────────────
  section('PERM-2.5  Notifications grant -> push registration');
  const push = src('lib/push.ts');
  check('Notifications grant registers this device\'s push token', /key === 'notifications'\) sideEffects\.push = registerPushToken\(\)/.test(flow));
  check('token is an Expo token bound on the backend', /getExpoPushTokenAsync/.test(push) && /pushApi\.register\(token, Platform\.OS\)/.test(push));
  check('Android channel (HIGH) exists before the dialog (Android 13 rule)', /await ensureNotificationChannel\(\);\s*return \(await notificationsModule\(\)\)\.requestPermissionsAsync\(\)/.test(perms) && /AndroidImportance\.HIGH/.test(push));
  check('foreground handler installed at boot', /void configureNotifications\(\)/.test(src('app/_layout.tsx')));
  check('backend relays a push to devices with no live socket', /!r\.pushed && r\.recipientDeviceId/.test(backendSrc('src/routes/relay.ts')) && /sendExpoPush/.test(backendSrc('src/routes/relay.ts')));
  check('app.json registers expo-notifications with the messages channel', /"expo-notifications"[\s\S]*"defaultChannel": "messages"/.test(readFileSync(join(MOBILE, 'app.json'), 'utf8')));

  section('PERM-2.6  Notifications denied: in-app unread stays live');
  {
    unreadStore.reset();
    const seen = new Set<string>();
    const thread = [
      { id: 'a', sent: true },
      { id: 'b', sent: false },
    ];
    const fresh1 = takeNewIncoming(thread, seen);
    fresh1.forEach(() => unreadStore.onIncomingMessage('c1', false));
    const fresh2 = takeNewIncoming([...thread, { id: 'c', sent: false }], seen);
    fresh2.forEach(() => unreadStore.onIncomingMessage('c1', false));
    takeNewIncoming([...thread, { id: 'c', sent: false }], seen).forEach(() => unreadStore.onIncomingMessage('c1', false));
    check('incoming on a closed chat bumps the badge', unreadStore.getSnapshot().c1 === 2);
    check('re-rendering/re-stamping a thread never over-counts', fresh2.length === 1);
    unreadStore.onIncomingMessage('c2', true);
    check('incoming on the OPEN chat adds no badge', !unreadStore.getSnapshot().c2);
    unreadStore.onChatOpened('c1');
    check('opening a chat clears its badge', !unreadStore.getSnapshot().c1 && unreadStore.getTotalUnread() === 0);
  }
  check('chat rows read the live unread store', /const unread = useUnreadCount\(chat\.id\)/.test(tabs));
  check('incoming messages are counted against the open chat', /unreadStore\.onIncomingMessage\(chatId, selectedRef\.current === chatId\)/.test(tabs));
  check('notifications-denied banner on the Chat List', /notificationsState === 'denied' \? <PermissionBanner permissionId="notifications" \/>/.test(tabs));
  check('no push token is registered unless granted', /if \(status !== 'granted'\) return \{ status: 'not_granted' \}/.test(push));

  // ───────────────────────────── PERM-2.7 / 2.8 ─────────────────────────────
  section('PERM-2.7 / 2.8  Microphone: voice notes on grant, Settings dialog on deny');
  check('only granted maps to record', decideRecordAction('granted') === 'record' && decideRecordAction('denied') === 'denied' && decideRecordAction('undetermined') === 'request');
  check('OS state -> gate', micGateFrom('granted') === 'granted' && micGateFrom('denied') === 'denied' && micGateFrom('unavailable') === 'denied' && micGateFrom('unknown') === 'undetermined');
  check('recording enabled only on grant', canRecordVoiceNotes('granted') && !canRecordVoiceNotes('denied') && !canRecordVoiceNotes('undetermined'));
  check('too-short recordings are not sent', !isUsableVoiceNote(0.4) && isUsableVoiceNote(1.2) && !isUsableVoiceNote(Number.NaN));
  check('duration formatting', formatVoiceDuration(65) === '1:05' && formatVoiceDuration(-3) === '0:00');
  const recorder = src('components/voice-record-button.tsx');
  check('the ONLY recorder lives in VoiceRecordButton', /useAudioRecorder\(/.test(recorder) && !/useAudioRecorder|AudioRecorder|prepareToRecordAsync|\.record\(\)/.test(tabs));
  check('VoiceRecordButton is mounted ONLY when the gate is granted', /micGate === 'granted' \? \(\s*<VoiceRecordButton/.test(tabs));
  check('press-and-hold gesture (onPressIn / onPressOut)', /onPressIn=\{onPressIn\}/.test(recorder) && /onPressOut=\{onPressOut\}/.test(recorder));
  check('denied -> Settings-redirect dialog', /action === 'denied'\) \{\s*openSettingsAlert\(\s*'Microphone access is off'/.test(tabs) && /Linking\.openSettings\(\)/.test(tabs));
  check('releasing before the recorder starts captures nothing', /if \(!holding\.current\) return;\s*recorder\.record\(\)/.test(recorder));
  check('mic gate is re-read on foreground (Settings round-trip)', /usePermissionState\('microphone'\)/.test(tabs) && /addEventListener\('change'[\s\S]*if \(s === 'active'\) refresh\(\)/.test(src('hooks/use-permission-state.ts')));

  // ───────────────────────────── PERM-2.9 – 2.12 ─────────────────────────────
  section('PERM-2.9 – 2.12  Camera and Photos/Files are independent');
  check('both attach options are always offered', attachOptions().join() === 'camera,photos');
  check('granted -> open, undetermined -> ask, denied -> settings', decideAttachAction('granted') === 'open' && decideAttachAction('unknown') === 'ask' && decideAttachAction(null) === 'ask' && decideAttachAction('denied') === 'settings' && decideAttachAction('unavailable') === 'settings');
  check('camera denied + photos granted: camera -> settings, gallery -> open', decideAttachAction('denied') === 'settings' && decideAttachAction('granted') === 'open');
  const camFn = tabs.slice(tabs.indexOf('const openCamera'), tabs.indexOf('const openGallery'));
  const galFn = tabs.slice(tabs.indexOf('const openGallery'), tabs.indexOf('const openAttachMenu'));
  check('camera path reads ONLY the camera permission', /cameraState/.test(camFn) && !/photosState|'photos'/.test(camFn));
  check('gallery path reads ONLY the photos permission', /photosState/.test(galFn) && !/cameraState|'camera'/.test(galFn));
  check('camera is never launched before a grant', /if \(decideAttachAction\(state\) !== 'open'\) \{[\s\S]*?return;\s*\}\s*const res = await ImagePicker\.launchCameraAsync/.test(camFn));
  check('camera denied -> Settings-redirect dialog', /'Camera access is off'/.test(camFn));
  check('gallery denied -> Settings-redirect dialog', /'Photos access is off'/.test(galFn));
  check('the attach menu offers both, unconditionally', /'Take photo'[\s\S]*'Choose from gallery'/.test(tabs) && !/disabled=\{[^}]*camera/i.test(tabs));

  // ───────────────────────────── PERM-2.13 / 2.14 ─────────────────────────────
  section('PERM-2.13 / 2.14  Re-grant detection, session-scoped banner dismissal');
  check('Contacts granted in Settings -> sync starts in place', /contactsState === 'granted' && \(sync\.status === 'idle' \|\| sync\.status === 'not_granted'\)/.test(tabs));
  resetBannerDismissals();
  check('banner visible before dismissal', !isBannerDismissed('contacts'));
  dismissBanner('contacts');
  check('dismissed banner stays hidden for the session', isBannerDismissed('contacts'));
  check('dismissal is per permission', !isBannerDismissed('notifications'));
  resetBannerDismissals();
  check('after an app restart the banner is back', !isBannerDismissed('contacts'));
  check('dismissal is NOT persisted (no storage)', !/SecureStore|AsyncStorage|localStorage/.test(src('lib/banner-dismissal.ts')));

  // ───────────────────────────── PERM-2.15 ─────────────────────────────
  section('PERM-2.15  All five denied (logic-level end to end)');
  {
    const store = memoryStore();
    const seq = createPermissionSequence({
      store,
      requesters: Object.fromEntries(PERMISSION_ORDER.map((k) => [k, async () => 'denied' as StepOutcome])) as Requesters,
    });
    await seq.arm();
    const r = await seq.run();
    check('all five denied still completes and unlocks the Chat List', r.stage === 'done' && PERMISSION_ORDER.every((k) => r.results[k] === 'denied'));
    const salt = 's';
    const chat = await lookupManualNumber('+14155552671', {
      getSalt: async () => salt,
      match: async () => [{ id: 'peer', name: 'Peer', about: '' }],
    });
    check('a chat can still be started (manual number)', chat.status === 'registered');
    unreadStore.reset();
    unreadStore.onIncomingMessage('peer', false);
    check('unread still shows in-app with notifications denied', unreadStore.getTotalUnread() === 1);
    check('voice note -> Settings dialog, never recording', decideRecordAction(micGateFrom('denied')) === 'denied');
    check('camera and gallery -> Settings dialog each, messaging unaffected', decideAttachAction('denied') === 'settings');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
