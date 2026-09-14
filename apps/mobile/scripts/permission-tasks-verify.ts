// @ts-nocheck
// scripts/permission-tasks-verify.ts
//
// Permissions epic — Node verification harness for the ported pure logic
// (Tasks 1-15 re-context). No device, no backend process, no native modules.
//
// Modules under test (all ported from the feature branch onto team-alpha):
//   lib/sha256.ts, lib/contact-hash.ts, lib/contact-sync.ts,
//   api/mockContactSyncApi.ts, api/mockPushApi.ts, lib/unread.ts,
//   lib/voice-note.ts, lib/banner-dismissal.ts, lib/permission-state.ts
//
// The only native dependency exercised is `expo-contacts`, which is stubbed
// below (same spirit as the SecureStore stub in scripts/onb-17-verify.ts).

import * as assert from 'node:assert';
import { createHash } from 'node:crypto';

// ── Node loader shims ────────────────────────────────────────────────────
// 1) Map the app's `@/` alias to the repo's apps/mobile dir.
// 2) Stub expo-contacts so lib/contact-sync can run its full paging/batching
//    path without a device.
const Module = require('node:module');
const origLoad = Module._load;
const CONTACTS_STUB = {
  Fields: { PhoneNumbers: 'phoneNumbers' },
};
Module._load = function (request, parent, isMain) {
  if (request === 'expo-contacts') return CONTACTS_STUB;
  if (request.startsWith('@/')) {
    const resolved = require('node:path').join(process.cwd(), request.slice(2));
    return origLoad.call(this, resolved, parent, isMain);
  }
  return origLoad.call(this, request, parent, isMain);
};

// ── Test plumbing ────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
  } catch (e) {
    fail += 1;
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
  } catch (e) {
    fail += 1;
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── T1: lib/sha256.ts — NIST vectors + cross-check against node:crypto ──
import { sha256Hex, isSha256Hex } from '../lib/sha256';

function testSha256() {
  check('T1a sha256("") == NIST empty', () => {
    assert.strictEqual(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  check('T1b sha256("abc") == NIST single-block', () => {
    assert.strictEqual(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  check('T1c sha256(fox) == NIST long', () => {
    assert.strictEqual(
      sha256Hex('The quick brown fox jumps over the lazy dog'),
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });
  check('T1d two-block NIST vector cross-checks node:crypto', () => {
    const twoBlock = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    assert.strictEqual(sha256Hex(twoBlock), createHash('sha256').update(twoBlock).digest('hex'));
  });
  check('T1e 200 random inputs match node:crypto', () => {
    const alphabet = 'abcdef0123456789 +-()x_@.é💬';
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 200; i += 1) {
      const len = rand() % 80;
      let s = '';
      for (let j = 0; j < len; j += 1) s += alphabet[rand() % alphabet.length];
      assert.strictEqual(sha256Hex(s), createHash('sha256').update(s).digest('hex'), `input ${JSON.stringify(s)}`);
    }
  });
  check('T1f isSha256Hex shape guard', () => {
    assert.strictEqual(isSha256Hex('a'.repeat(64)), true);
    assert.strictEqual(isSha256Hex('0'.repeat(64)), true);
    assert.strictEqual(isSha256Hex('A'.repeat(64)), false);
    assert.strictEqual(isSha256Hex('g'.repeat(64)), false);
    assert.strictEqual(isSha256Hex('a'.repeat(63)), false);
    assert.strictEqual(isSha256Hex('a'.repeat(65)), false);
  });
}

// ── T2: lib/contact-hash.ts — E.164 normalize + hashing contract ──
import { normalizeToE164, hashContactNumber, isContactHash } from '../lib/contact-hash';

function testContactHash() {
  check('T2a NORMALIZE full E.164 passes through', () => {
    assert.strictEqual(normalizeToE164('+14155552671'), '+14155552671');
  });
  check('T2b NORMALIZE raw US number with country code', () => {
    assert.strictEqual(normalizeToE164('4155552671', 'US'), '+14155552671');
  });
  check('T2c NORMALIZE international IN number', () => {
    assert.strictEqual(normalizeToE164('+919876543210'), '+919876543210');
  });
  check('T2d NORMALIZE malformed/garbage rejected', () => {
    assert.strictEqual(normalizeToE164('not a number'), null);
    assert.strictEqual(normalizeToE164('123'), null);
    assert.strictEqual(normalizeToE164(''), null);
    assert.strictEqual(normalizeToE164('user@example.com'), null);
  });
  check('T2e HASH determinism + 64-hex shape', () => {
    const h1 = hashContactNumber('+14155552671', 'onb-contacts-v1_mock_salt');
    const h2 = hashContactNumber('+14155552671', 'onb-contacts-v1_mock_salt');
    assert.strictEqual(h1, h2);
    assert.strictEqual(h1.length, 64);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });
  check('T2f HASH differs across salts/numbers', () => {
    const a = hashContactNumber('+14155552671', 'salt1');
    const b = hashContactNumber('+14155552671', 'salt2');
    const c = hashContactNumber('+14155552672', 'salt1');
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a, c);
  });
  check('T2g isContactHash contract', () => {
    assert.strictEqual(isContactHash(hashContactNumber('+14155552671', 'x')), true);
    assert.strictEqual(isContactHash('+14155552671'), false);
    assert.strictEqual(isContactHash('abc'), false);
  });
}

// ── T3: api/mockContactSyncApi.ts — hash-only endpoint contract ──
import { contactSyncApi, mockContactSyncDebug, GLOBAL_SALT, MAX_BATCH } from '../api/mockContactSyncApi';

async function testContactSyncApi() {
  await checkAsync('T3a endpoint refuses EMPTY batch', async () => {
    await assert.rejects(contactSyncApi.syncContactHashes([]), (e) => e.message === 'EMPTY_BATCH');
  });
  await checkAsync('T3b endpoint rejects raw number (INVALID_HASH)', async () => {
    await assert.rejects(contactSyncApi.syncContactHashes(['+14155552671']), (e) => e.message === 'INVALID_HASH');
  });
  await checkAsync('T3c endpoint rejects oversized batch (BATCH_TOO_LARGE)', async () => {
    const big = Array.from({ length: MAX_BATCH + 1 }, () => 'a'.repeat(64));
    await assert.rejects(contactSyncApi.syncContactHashes(big), (e) => e.message === 'BATCH_TOO_LARGE');
  });
  await checkAsync('T3d valid one-item batch matches registered number', async () => {
    mockContactSyncDebug.reset();
    const hash = hashContactNumber(normalizeToE164('4155552671', 'US') ?? '', GLOBAL_SALT);
    const res = await contactSyncApi.syncContactHashes([hash]);
    assert.strictEqual(res.accepted, 1);
    assert.strictEqual(res.matched, 1);
  });
  check('T3e registered matching: known user yes, unknown no', () => {
    assert.strictEqual(mockContactSyncDebug.matchesRegistered('+14155552671'), true);
    assert.strictEqual(mockContactSyncDebug.matchesRegistered('+911234567890'), true);
    assert.strictEqual(mockContactSyncDebug.matchesRegistered('+919876543210'), true);
    assert.strictEqual(mockContactSyncDebug.matchesRegistered('+18005550199'), false);
  });
  await checkAsync('T3f 1200-entry payload rejected at once, then chunked 250-batch slice accepted', async () => {
    mockContactSyncDebug.reset();
    const hashes = Array.from({ length: 1200 }, (_, i) => 'a'.repeat(64));
    await assert.rejects(contactSyncApi.syncContactHashes(hashes), (e) => e.message === 'BATCH_TOO_LARGE');
    for (let i = 0; i < 5; i += 1) {
      const batch = hashes.slice(i * 250, (i + 1) * 250);
      const res = await contactSyncApi.syncContactHashes(batch);
      assert.strictEqual(res.accepted, batch.length);
    }
    assert.strictEqual(mockContactSyncDebug.receivedPayloadCount(), 5);
    assert.strictEqual(mockContactSyncDebug.assertOnlyHashesReceived(), true);
  });
}

// ── T4: lib/contact-sync.ts — full read→hash→batch path (expo-contacts stubbed) ──
import {
  syncContactsFromDevice,
  ContactSyncError,
  SYNC_UPLOAD_BATCH_SIZE,
  SYNC_MAX_BATCH,
} from '../lib/contact-sync';

function buildContacts(validCount) {
  const contacts = [];
  for (let i = 0; i < validCount; i += 1) {
    let number;
    let countryCode;
    if (i < 900) {
      number = `415555${String(i).padStart(4, '0')}`;
      countryCode = 'US';
    } else {
      number = `+91${String(9870000000 + i)}`;
      countryCode = undefined;
    }
    contacts.push({ phoneNumbers: [{ number, countryCode }] });
  }
  return contacts;
}

async function testContactSync() {
  await checkAsync('T4a sync completes on grant: counts + batches (1200 valid, 300 junk)', async () => {
    mockContactSyncDebug.reset();
    const contacts = buildContacts(1200);
    for (let i = 0; i < 300; i += 1) {
      if (i % 3 === 0) contacts.push({ phoneNumbers: [{ number: 'not a number', countryCode: 'US' }] });
      else if (i % 3 === 1) contacts.push({ phoneNumbers: [{ number: 'user@example.com', countryCode: 'US' }] });
      else contacts.push({});
    }
    CONTACTS_STUB.getPermissionsAsync = async () => ({ granted: true, accessPrivileges: 'full' });
    CONTACTS_STUB.getContactsAsync = async ({ pageSize, pageOffset }) => {
      const page = contacts.slice(pageOffset, pageOffset + pageSize);
      return { data: page, hasNextPage: pageOffset + page.length < contacts.length };
    };
    const outcome = await syncContactsFromDevice();
    assert.strictEqual(outcome.status, 'completed');
    assert.strictEqual(outcome.contactsRead, 1500);
    assert.strictEqual(outcome.validNumbers, 1200);
    assert.strictEqual(outcome.skipped, 200);
    assert.strictEqual(outcome.uniqueHashes, 1200);
    assert.strictEqual(outcome.batchesSent, Math.ceil(1200 / SYNC_UPLOAD_BATCH_SIZE));
    assert.strictEqual(outcome.acceptedHashes, 1200);
    assert.strictEqual(mockContactSyncDebug.assertOnlyHashesReceived(), true);
    assert.strictEqual(SYNC_MAX_BATCH >= 250, true);
  });
  await checkAsync('T4b sync returns not_granted when permission missing', async () => {
    CONTACTS_STUB.getPermissionsAsync = async () => ({ granted: false });
    CONTACTS_STUB.getContactsAsync = async () => ({ data: [], hasNextPage: false });
    const outcome = await syncContactsFromDevice();
    assert.strictEqual(outcome.status, 'not_granted');
  });
  check('T4c ContactSyncError carries partial counts', () => {
    const err = new ContactSyncError('boom', { contactsRead: 5, validNumbers: 4, acceptedHashes: 250, batchesSent: 1 });
    assert.strictEqual(err.message, 'boom');
    assert.strictEqual(err.contactsRead, 5);
    assert.strictEqual(err.validNumbers, 4);
    assert.strictEqual(err.acceptedHashes, 250);
    assert.strictEqual(err.batchesSent, 1);
    assert.strictEqual(err.toOutcome().status, 'failed');
  });
}

// ── T5: api/mockPushApi.ts — push-token registry contract ──
import { pushApi, mockPushDebug, MOCK_PUSH_TOKEN } from '../api/mockPushApi';

async function testPushApi() {
  await checkAsync('T5a raw/malformed token rejected', async () => {
    mockPushDebug.reset();
    assert.strictEqual(mockPushDebug.isRegistered(), false);
    await assert.rejects(pushApi.registerToken('some-raw-token'), (e) => e.message === 'INVALID_TOKEN');
    await assert.rejects(pushApi.registerToken('ExponentPushToken[short]'), (e) => e.message === 'INVALID_TOKEN');
    await assert.rejects(pushApi.registerToken('ExponentPushToken[]'), (e) => e.message === 'INVALID_TOKEN');
  });
  await checkAsync('T5b valid token accepted + idempotent re-register', async () => {
    mockPushDebug.reset();
    await pushApi.registerToken(MOCK_PUSH_TOKEN);
    assert.strictEqual(mockPushDebug.isRegistered(), true);
    assert.strictEqual(mockPushDebug.registeredToken(), MOCK_PUSH_TOKEN);
    await pushApi.registerToken(MOCK_PUSH_TOKEN);
    assert.strictEqual(mockPushDebug.registeredToken(), MOCK_PUSH_TOKEN);
  });
}

// ── T6: lib/unread.ts — deny-path in-app unread accounting ──
import { onIncomingMessage, onChatOpened, totalUnread, hasUnread } from '../lib/unread';

function testUnread() {
  check('T6a unread scenario: incoming-not-open bumps & accumulates; open adds nothing; open clears', () => {
    let s = {};
    s = onIncomingMessage(s, 'c1', false);
    s = onIncomingMessage(s, 'c1', false);
    assert.strictEqual(hasUnread(s, 'c1'), true);
    s = onIncomingMessage(s, 'c1', true);
    assert.strictEqual(s.c1, 2, 'open chat must not overcount (stays 2)');
    s = onIncomingMessage(s, 'c2', false);
    assert.strictEqual(totalUnread(s), 3);
    s = onChatOpened(s, 'c1');
    assert.strictEqual(hasUnread(s, 'c1'), false);
    assert.strictEqual(totalUnread(s), 1);
  });
  check('T6b unread immutability (input never mutated)', () => {
    const before = { c1: 1 };
    const after = onChatOpened(before, 'c1');
    assert.strictEqual(before.c1, 1);
    assert.strictEqual(after.c1, undefined);
    assert.notStrictEqual(before, after);
  });
  check('T6c unread opening unbadged chat is a no-op', () => {
    const s = { c2: 2 };
    const r = onChatOpened(s, 'c1');
    assert.strictEqual(r, s);
  });
}

// ── T7: lib/voice-note.ts — mic gate classification + record decision ──
import {
  classifyMicGranted,
  canRecordVoiceNotes,
  decideRecordAction,
  isUsableVoiceNote,
  formatVoiceDuration,
  buildVoiceNoteDraft,
} from '../lib/voice-note';

function testVoiceNote() {
  check('T7a classifyMicGranted mapping', () => {
    assert.strictEqual(classifyMicGranted(true, 'granted'), 'granted');
    assert.strictEqual(classifyMicGranted(false, 'granted'), 'undetermined');
    assert.strictEqual(classifyMicGranted(false, 'denied'), 'denied');
    assert.strictEqual(classifyMicGranted(false, 'blocked'), 'denied');
    assert.strictEqual(classifyMicGranted(false, 'limited'), 'denied');
    assert.strictEqual(classifyMicGranted(false, 'undetermined'), 'undetermined');
  });
  check('T7b recording enabled ONLY on grant', () => {
    assert.strictEqual(canRecordVoiceNotes('granted'), true);
    assert.strictEqual(canRecordVoiceNotes('denied'), false);
    assert.strictEqual(canRecordVoiceNotes('undetermined'), false);
  });
  check('T7c decideRecordAction decision table', () => {
    assert.strictEqual(decideRecordAction('granted'), 'record');
    assert.strictEqual(decideRecordAction('undetermined'), 'request');
    assert.strictEqual(decideRecordAction('denied'), 'denied');
  });
  check('T7d voice note length rules', () => {
    assert.strictEqual(isUsableVoiceNote(1), true);
    assert.strictEqual(isUsableVoiceNote(0), false);
    assert.strictEqual(isUsableVoiceNote(0.5), false);
    assert.strictEqual(formatVoiceDuration(0), '0:00');
    assert.strictEqual(formatVoiceDuration(65), '1:05');
    assert.strictEqual(formatVoiceDuration(3599), '59:59');
  });
  check('T7e buildVoiceNoteDraft contract + throw paths', () => {
    assert.throws(() => buildVoiceNoteDraft('', 3), /VOICE_NOTE_NO_URI/);
    assert.throws(() => buildVoiceNoteDraft('file://x.m4a', 0.4), /VOICE_NOTE_TOO_SHORT/);
    const now = new Date();
    const draft = buildVoiceNoteDraft('file://x.m4a', 3, now);
    assert.strictEqual(draft.audioUri, 'file://x.m4a');
    assert.strictEqual(draft.durationSec, 3);
    assert.strictEqual(draft.id, `vn${now.getTime()}`);
    assert.strictEqual(draft.sentAt.getTime(), now.getTime());
  });
}

// ── T8: lib/banner-dismissal.ts — session-scoped dismissal ──
import { isBannerDismissed, dismissBanner } from '../lib/banner-dismissal';

function testBannerDismissal() {
  check('T8a dismiss is session-scoped + key-independent', () => {
    assert.strictEqual(isBannerDismissed('contacts'), false);
    dismissBanner('contacts');
    assert.strictEqual(isBannerDismissed('contacts'), true);
    assert.strictEqual(isBannerDismissed('notifications'), false);
  });
}

// ── T9: lib/permission-state.ts — three-state gate decisions ──
import {
  classifyFeatureGate,
  decideAttachAction,
  canOpenFeature,
} from '../lib/permission-state';

function testPermissionState() {
  check('T9a classifyFeatureGate mapping', () => {
    assert.strictEqual(classifyFeatureGate('granted'), 'granted');
    assert.strictEqual(classifyFeatureGate('unknown'), 'undetermined');
    assert.strictEqual(classifyFeatureGate('denied'), 'denied');
    assert.strictEqual(classifyFeatureGate('unavailable'), 'denied');
  });
  check('T9b decideAttachAction: granted opens; undetermined asks first (never settings); denied ask -> settings', () => {
    assert.strictEqual(decideAttachAction('granted'), 'open');
    assert.strictEqual(decideAttachAction('undetermined'), 'ask');
    assert.strictEqual(decideAttachAction('denied'), 'ask', 'stale-denied-without-ask re-asks the OS once');
    assert.strictEqual(decideAttachAction('undetermined', { granted: true }), 'open');
    assert.strictEqual(decideAttachAction('undetermined', { granted: false }), 'settings');
    assert.strictEqual(decideAttachAction('granted', { granted: false }), 'open');
  });
  check('T9c canOpenFeature', () => {
    assert.strictEqual(canOpenFeature('granted'), true);
    assert.strictEqual(canOpenFeature('denied'), false);
    assert.strictEqual(canOpenFeature('undetermined'), false);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  testSha256();
  testContactHash();
  await testContactSyncApi();
  await testContactSync();
  await testPushApi();
  testUnread();
  testVoiceNote();
  testBannerDismissal();
  testPermissionState();

  console.log(`pass=${pass} fail=${fail}`);
  for (const f of failures) console.log(`FAIL ${f}`);
  if (fail > 0) process.exit(1);
  console.log('ALL PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});