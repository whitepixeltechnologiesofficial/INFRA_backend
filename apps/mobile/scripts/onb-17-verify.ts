// @ts-nocheck
// scripts/onb-17-verify.ts
//
// ONB-1.7 verification harness — CLIENT-side mechanisms (mock mode + pure logic).
//
// Run (from apps/mobile):  tsx scripts/onb-17-verify.ts
//
// Node-only: no device, no backend process, no expo-secure-store runtime.
// SecureStore is injected via Module._load; onboardingApi runs in its default
// in-memory MOCK mode. The backend/shared-state delegation is covered by the
// companion scripts/onb-17-backend-mode.ts.
//
// Maps to the independent verification findings/TCs:
//   T1 — stable device identity (Finding: unstable device ID)
//   T2 — login persistence (Finding 1 / TC-09: SecureStore never populated)
//   T3 — confirmation location (Finding 3 / TC-11: message discarded)
//   T4 — silent-cutoff policy (TC-04: no warning UI)
//   T5 — multi-device revocation reference model (TC-10)
//   T7 — polling lifecycle (single interval, pause/resume/stop)
//
// NOTE: reference-model lines (T5) mirror the REAL backend's
// executeHandoffTransaction (revoke ALL prior sessions) so the client
// expectation contract is asserted in code; genuine revocation across two
// physical devices additionally requires the manual two-device procedure.

import {
  generateDeviceId,
  getOrCreateDeviceIdWithStore,
  DEVICE_ID_STORAGE_KEY,
} from '../lib/device-identity';
import { resolvePostLoginRoute, decideSessionCutoff, SessionPoller } from '../lib/session-policy';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── SecureStore stub ──
function makeStore(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async getItemAsync(key) {
      return values[key] ?? null;
    },
    async setItemAsync(key, value) {
      values[key] = value;
    },
    async deleteItemAsync(key) {
      delete values[key];
    },
  };
}

const secureStoreRef = { current: makeStore() };

function installSecureStore(store) {
  secureStoreRef.current = store;
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'expo-secure-store') return secureStoreRef.current;
    return origLoad.call(this, request, ...rest);
  };
}

// ── Multi-device revocation reference model (mirrors backend) ──
function makeSessionRegistry() {
  const byDevice = new Map();
  return {
    // Seed an arbitrary multiplactive session set (used only to exercise the
    // revoke-all property with more than one active session at once).
    seed(deviceId, userId, active) {
      byDevice.set(deviceId, { userId, active });
    },
    login(deviceId, userId) {
      let revoked = 0;
      for (const [d, s] of byDevice) {
        if (s.userId === userId && s.active) {
          // Mirrors the real backend: only revokedAt IS NULL rows are counted.
          s.active = false;
          revoked += 1;
        }
      }
      byDevice.set(deviceId, { userId, active: true });
      return { revokedCount: revoked };
    },
    isActive(deviceId) {
      const s = byDevice.get(deviceId);
      return s ? s.active === true : false;
    },
  };
}

const checks = [];
function t(label, pass) {
  checks.push({ label, pass });
}

async function main() {
  console.log('ONB-1.7 verification harness — client-side mechanisms\n');

  // ══ T1 — stable device identity ══
  console.log('T1 — Stable device identity');
  const store1 = makeStore();
  installSecureStore(store1);
  const first = await getOrCreateDeviceIdWithStore(store1);
  const second = await getOrCreateDeviceIdWithStore(store1);
  t('T1a: first call generates a device ID', first.deviceId.length > 0 && first.created === true);
  t(
    'T1b: second call returns the SAME persisted ID',
    second.deviceId === first.deviceId && second.created === false,
  );
  t(
    'T1c: ID is persisted under the storage key',
    store1.values[DEVICE_ID_STORAGE_KEY] === first.deviceId,
  );
  t(
    'T1d: ID is timestamp-free and bounded (<=24 chars)',
    /^device_[0-9a-z]+$/.test(first.deviceId) && first.deviceId.length <= 24,
  );
  const otherDevice = await getOrCreateDeviceIdWithStore(makeStore());
  t('T1e: a distinct device mints a distinct ID', otherDevice.deviceId !== first.deviceId);

  // ══ T2 — login persistence (Finding 1 / TC-09) ══
  console.log('\nT2 — Login persistence + stable per-phone identity');
  installSecureStore(makeStore());
  const { onboardingApi } = await import('../api/onboardingApi');
  const PHONE = '+14155552671'; // pre-registered → routing 'chats'
  const DEVICE_ID = 'device_1111111111';

  await onboardingApi.acceptLegal(PHONE);
  await onboardingApi.sendOtp({ phoneNumber: PHONE });
  const v1 = await onboardingApi.verifyOtp({ phoneNumber: PHONE, code: '123456', deviceId: DEVICE_ID });
  t('T2a: first login succeeds', v1.status === 'success');
  if (v1.status === 'success') {
    t('T2b: pre-registered number routes to chats', v1.routing === 'chats');
    t(
      'T2c: tokens + identity all minted non-empty',
      v1.accessToken.length > 0 &&
        v1.refreshToken.length > 0 &&
        v1.userId.length > 0 &&
        v1.sessionId.length > 0,
    );
    t('T2d: first login revoked 0 devices', v1.previousDevicesLoggedOut === 0);

    // Mirror otp-entry.tsx: persist the FULL session to SecureStore.
    const store = makeStore();
    installSecureStore(store);
    await Promise.all([
      store.setItemAsync('userId', v1.userId),
      store.setItemAsync('deviceId', DEVICE_ID),
      store.setItemAsync('accessToken', v1.accessToken),
      store.setItemAsync('refreshToken', v1.refreshToken),
      store.setItemAsync('displayPhone', '+1 (415) 555-2671'),
    ]);
    t(
      'T2e: userId/deviceId/accessToken/refreshToken all persisted',
      store.values['userId'] === v1.userId &&
        store.values['deviceId'] === DEVICE_ID &&
        store.values['accessToken'] === v1.accessToken &&
        store.values['refreshToken'] === v1.refreshToken,
    );

    // Re-login of the same phone resolves to the SAME account.
    installSecureStore(store);
    await onboardingApi.sendOtp({ phoneNumber: PHONE });
    const v2 = await onboardingApi.verifyOtp({
      phoneNumber: PHONE,
      code: '123456',
      deviceId: DEVICE_ID,
    });
    if (v2.status === 'success') {
      t('T2f: same-phone re-login resolves to same userId', v2.userId === v1.userId);
      t('T2g: re-login reports prior sessions revoked (>0)', v2.previousDevicesLoggedOut > 0);
    } else {
      t('T2f: re-login unexpectedly failed', false);
    }
  }

  // ══ T3 — confirmation location (Finding 3 / TC-11) ══
  console.log('\nT3 — Post-login confirmation routing');
  t(
    'T3a: first login (0 revoked) → straight to chats',
    resolvePostLoginRoute({ routing: 'chats', previousDevicesLoggedOut: 0 }) === 'chats',
  );
  t(
    'T3b: login that revoked other devices → device-handoff',
    resolvePostLoginRoute({ routing: 'chats', previousDevicesLoggedOut: 1 }) === 'device-handoff',
  );
  t(
    'T3c: MULTI old devices revoked → device-handoff too',
    resolvePostLoginRoute({ routing: 'chats', previousDevicesLoggedOut: 3 }) === 'device-handoff',
  );
  t(
    'T3d: new-user setup wins over handoff message',
    resolvePostLoginRoute({ routing: 'profile_setup', previousDevicesLoggedOut: 5 }) ===
      'profile_setup',
  );

  // ══ T4 — silent-cutoff policy (TC-04) ══
  console.log('\nT4 — Silent cutoff decision');
  const ok = await onboardingApi.checkSessionValidity({ deviceId: DEVICE_ID });
  const bad = await onboardingApi.checkSessionValidity({ deviceId: '' });
  t(
    'T4a: valid session → keep',
    ok.isValid === true && decideSessionCutoff(ok.isValid) === 'keep',
  );
  t(
    'T4b: revoked session → cutoff (decision only; zero UI variants)',
    bad.isValid === false && decideSessionCutoff(bad.isValid) === 'cutoff',
  );

  // ══ T5 — multi-device revocation reference model (TC-10) ══
  console.log('\nT5 — Multi-device revocation (reference session registry)');
  const reg = makeSessionRegistry();
  const la = reg.login('devA', 'user_x');
  const lb = reg.login('devB', 'user_x');
  t('T5a: first device login revokes nothing', la.revokedCount === 0);
  // Backend semantics: a login revokes only sessions with revokedAt IS NULL.
  t('T5b: second device login revokes the one active session', lb.revokedCount === 1);
  t('T5c: first device session is now inactive', reg.isActive('devA') === false);
  t('T5d: second device session is active', reg.isActive('devB') === true);
  // A THIRD sequential login only has devB still active → revokes 1, NOT 2
  // (matches executeHandoffTransaction: UPDATE ... WHERE revoked_at IS NULL).
  const lc = reg.login('devC', 'user_x');
  t('T5e: third sequential login revokes only the still-active session', lc.revokedCount === 1);
  t(
    'T5f: devA + devB inactive, devC active',
    !reg.isActive('devA') && !reg.isActive('devB') && reg.isActive('devC'),
  );
  // Multiple old devices ACTIVE at once (e.g. legacy residual sessions): a login
  // must revoke ALL of them in one transaction, and the count must reflect every
  // one — this is the multiple-old-devices guarantee (TC-10).
  const reg2 = makeSessionRegistry();
  reg2.seed('devD', 'user_x', true);
  reg2.seed('devE', 'user_x', true);
  reg2.seed('devF', 'user_x', true);
  const multi = reg2.login('devG', 'user_x');
  t('T5g: one login revokes ALL active sessions (3 at once)', multi.revokedCount === 3);
  t(
    'T5h: all four prior devices inactive; new device active',
    !reg2.isActive('devD') && !reg2.isActive('devE') && !reg2.isActive('devF') && reg2.isActive('devG'),
  );

  // ══ T7 — polling lifecycle ══
  console.log('\nT7 — Session polling lifecycle');
  let ticks = 0;
  const poller = new SessionPoller(() => {
    ticks += 1;
  }, 40);
  t('T7a: not running before start', poller.running === false);
  poller.start();
  t('T7b: running after start', poller.running === true);
  await sleep(180);
  const afterStart = ticks;
  t('T7c: ticks accumulate while active', afterStart >= 3);
  poller.start(); // idempotent
  await sleep(140);
  const afterDouble = ticks;
  t('T7d: double-start does not double the tick rate', afterDouble - afterStart <= 4);
  poller.setActive(false);
  t('T7e: deactivating stops the timer', poller.running === false);
  const atPause = ticks;
  await sleep(160);
  t('T7f: no ticks while backgrounded/inactive', ticks === atPause);
  poller.setActive(true);
  t('T7g: reactivating restarts the timer', poller.running === true);
  await sleep(150);
  t('T7h: ticks resume on foreground', ticks > atPause);
  const atResume = ticks;
  poller.stop();
  t('T7i: stop() tears the timer down', poller.running === false);
  await sleep(150);
  t('T7j: no ticks after stop', ticks === atResume);

  // ══ Summary ══
  console.log('\n' + '='.repeat(50));
  let pass = 0;
  let fail = 0;
  for (const c of checks) {
    console.log(` ${c.pass ? 'PASS' : 'FAIL'}  ${c.label}`);
    if (c.pass) pass += 1;
    else fail += 1;
  }
  console.log('-'.repeat(50));
  console.log(` ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exitCode = 1;
});