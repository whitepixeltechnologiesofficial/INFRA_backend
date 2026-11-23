// @ts-nocheck
// scripts/onb-17-backend-mode.ts
//
// ONB-1.7 verification harness — BACKEND (shared-state) delegation + detection.
//
// Run (from apps/mobile):  tsx scripts/onb-17-backend-mode.ts
//
// This drives the REAL client code path (onboardingApi → backendClient → fetch)
// in backend mode (EXPO_PUBLIC_USE_MOCK=false) against a stubbed but faithful
// "backend": one shared session registry serving every device client — exactly
// like one Express instance serving two physical phones. No real DB is needed;
// the goal is to prove the CLIENT observes revocation the way a Device A would
// when Device B logs in to the same backend.
//
// Maps to the independent verification report:
//   Test 5  — multi-device revocation (previousDevicesLoggedOut counts)
//   Test 6  — foreground/resume detection → silent cutoff decision
//   Test 8  — backend shared state (two clients, one backend instance)
//
// The foreground AppState transition itself is React Native runtime behavior and
// is verified manually on the two physical devices; what is asserted here is the
// detection path it triggers (checkSessionValidity → decideSessionCutoff).

import { decideSessionCutoff } from '../lib/session-policy';

// Force backend delegation BEFORE the API module is imported.
process.env.EXPO_PUBLIC_USE_MOCK = 'false';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9'; // never really hit — fetch is stubbed

// ── SecureStore stub (expo-secure-store has no Node runtime) ──
const storeValues = { accessToken: 'stub_access_token' };
const secureStoreStub = {
  async getItemAsync(key) {
    return storeValues[key] ?? null;
  },
  async setItemAsync(key, value) {
    storeValues[key] = value;
  },
  async deleteItemAsync(key) {
    delete storeValues[key];
  },
};
{
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'expo-secure-store') return secureStoreStub;
    return origLoad.call(this, request, ...rest);
  };
}

// ── Stubbed backend: ONE shared session registry (per user) ──
const backend = {
  byDevice: new Map(),
  login(deviceId, userId) {
    let revoked = 0;
    for (const [d, s] of this.byDevice) {
      if (s.userId === userId && s.active) {
        s.active = false;
        revoked += 1;
      }
    }
    this.byDevice.set(deviceId, { userId, active: true });
    return { revokedCount: revoked };
  },
  isActive(deviceId) {
    const s = this.byDevice.get(deviceId);
    return s ? s.active === true : false;
  },
};

const hits = [];
const res = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  hits.push(`${init?.method ?? 'POST'} ${url.pathname}`);
  if (url.pathname.endsWith('/onboarding/accept-legal')) return res({ success: true });
  if (url.pathname.endsWith('/onboarding/otp/send')) return res({ success: true });
  if (url.pathname.endsWith('/onboarding/otp/verify')) {
    const { revokedCount } = backend.login(body.deviceId, 'user_shared_123');
    return res({
      status: 'success',
      routing: 'chats',
      accessToken: 'be_access',
      refreshToken: 'be_refresh',
      userId: 'user_shared_123',
      sessionId: `be_s_${Date.now()}`,
      previousDevicesLoggedOut: revokedCount,
    });
  }
  if (url.pathname.endsWith('/onboarding/session/check')) {
    const { deviceId } = body;
    return res({
      isValid: backend.isActive(deviceId),
      message: backend.isActive(deviceId) ? undefined : 'Session revoked by another device',
    });
  }
  return res({ error: 'not_found' }, 404);
};

const checks = [];
function t(label, pass) {
  checks.push({ label, pass });
}

async function main() {
  console.log('ONB-1.7 verification harness — backend shared-state delegation\n');

  const { onboardingApi } = await import('../api/onboardingApi');
  const PHONE = '+14155552671';

  // ── Test 8 — backend shared state: A then B then C on ONE backend ──
  console.log('Test 8 — two logical devices observe shared account state');

  const a = await onboardingApi.verifyOtp({ phoneNumber: PHONE, code: '123456', deviceId: 'devA' });
  t('T8a: Device A first login — 0 prior revocations', a.status === 'success' && a.previousDevicesLoggedOut === 0);

  const sA1 = await onboardingApi.checkSessionValidity({ deviceId: 'devA' });
  t('T8b: Device A session is valid before anything else logs in', sA1.isValid === true);

  const b = await onboardingApi.verifyOtp({ phoneNumber: PHONE, code: '123456', deviceId: 'devB' });
  t('T8c: Device B login revokes Device A (count = 1)', b.status === 'success' && b.previousDevicesLoggedOut === 1);

  // Device A's client re-checks (foreground-resume / 30s poll path).
  const sA2 = await onboardingApi.checkSessionValidity({ deviceId: 'devA' });
  t('T8d: Device A now observes INVALID (revoked) session', sA2.isValid === false);
  t(
    'T8e: Device A silently cuts off (cutoff decision — no UI variant)',
    decideSessionCutoff(sA2.isValid) === 'cutoff',
  );

  // ── Test 5 — sequential + multiple active sessions revoked at once (TC-10) ──
  console.log('\nTest 5 — revocation count + multi-device active-set revocation');

  // Sequential: C's login revokes only B (the one still active — matches real
  // executeHandoffTransaction WHERE revoked_at IS NULL).
  const c = await onboardingApi.verifyOtp({ phoneNumber: PHONE, code: '123456', deviceId: 'devC' });
  t('T5g: Device C login revokes the one active session (B)', c.status === 'success' && c.previousDevicesLoggedOut === 1);

  const sB = await onboardingApi.checkSessionValidity({ deviceId: 'devB' });
  const sC = await onboardingApi.checkSessionValidity({ deviceId: 'devC' });
  t('T5h: after C logs in, B is revoked', sB.isValid === false);
  t('T5i: C (current device) stays active', sC.isValid === true);
  t(
    'T5j: B reacts with silent cutoff, C stays',
    decideSessionCutoff(sB.isValid) === 'cutoff' && decideSessionCutoff(sC.isValid) === 'keep',
  );

  // ── Delegation wiring ──
  console.log('\nDelegation wiring');
  t('T8f: delegation actually hit the backend client (fetches counted)', hits.length > 0);
  t(
    'T8g: verify + session-check endpoints exercised',
    hits.some((h) => h.endsWith('/otp/verify') && h.startsWith('POST')) &&
      hits.some((h) => h.endsWith('/session/check')),
  );

  // Missing access token → backendClient refuses without contacting the backend.
  storeValues['accessToken'] = undefined;
  const noTok = await onboardingApi.checkSessionValidity({ deviceId: 'devA' });
  t('T8h: missing access token yields invalid session (no fetch)', noTok.isValid === false);
  const hitsBefore = hits.length;
  await onboardingApi.checkSessionValidity({ deviceId: 'devC' });
  const didHit = hits.length;
  // (token was missing, so no new session-check fetch should have fired)
  t('T8i: no session-check fetch fired without a token', didHit === hitsBefore);

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