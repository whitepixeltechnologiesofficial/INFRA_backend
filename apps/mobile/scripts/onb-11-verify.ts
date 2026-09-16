// @ts-nocheck
// scripts/onb-11-verify.ts
//
// ONB-1.1 verification harness — central guard + provenance logic.
//
// Run:  tsx scripts/onb-11-verify.ts
//
// Node-only: no device, no expo-secure-store runtime. Pure-logic tests on
// lib/onboarding-guard.ts plus the store-shim + provider snapshot behavior.

import {
  resolveSnapshot,
  canAccess,
  decideSplashAction,
  ROUTE_TIERS,
  PUBLIC_ROUTES,
  LEGAL_REQUIRED_ROUTES,
  SESSION_REQUIRED_ROUTES,
  STORE_KEYS,
} from '../lib/onboarding-guard';

const checks = [];
function t(label, pass) {
  checks.push({ label, pass });
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

function makeStore(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async getItemAsync(key) { return values[key] ?? null; },
    async setItemAsync(key, value) { values[key] = value; },
    async deleteItemAsync(key) { delete values[key]; },
  };
}

async function main() {
  console.log('ONB-1.1 verification harness — central guard + provenance\n');

  // ══ T1 — Tier classification completeness ══
  section('T1 — Tier classification completeness');

  t('index is public', ROUTE_TIERS['index'] === 'public');
  t('legal-acceptance is public', ROUTE_TIERS['legal-acceptance'] === 'public');
  t('done is public', ROUTE_TIERS['done'] === 'public');
  t('modal is public', ROUTE_TIERS['modal'] === 'public');
  t('phone-entry is legal_required', ROUTE_TIERS['phone-entry'] === 'legal_required');
  t('otp-entry is legal_required', ROUTE_TIERS['otp-entry'] === 'legal_required');
  t('profile-setup is session_required', ROUTE_TIERS['profile-setup'] === 'session_required');
  t('permission-intro is session_required', ROUTE_TIERS['permission-intro'] === 'session_required');
  t('notifications-info is session_required', ROUTE_TIERS['notifications-info'] === 'session_required');
  t('permission-info is session_required', ROUTE_TIERS['permission-info'] === 'session_required');
  t('device-handoff is session_required', ROUTE_TIERS['device-handoff'] === 'session_required');
  t('settings is session_required', ROUTE_TIERS['settings'] === 'session_required');
  t('(tabs) is session_required', ROUTE_TIERS['(tabs)'] === 'session_required');
  t('scan is session_required', ROUTE_TIERS['scan'] === 'session_required');
  t('blocked-contacts is session_required', ROUTE_TIERS['blocked-contacts'] === 'session_required');
  t('PUBLIC_ROUTES has 4 entries', PUBLIC_ROUTES.length === 4);
  t('LEGAL_REQUIRED_ROUTES has 2 entries', LEGAL_REQUIRED_ROUTES.length === 2);
  t('SESSION_REQUIRED_ROUTES has 9 entries', SESSION_REQUIRED_ROUTES.length === 9);

  // ══ T2 — canAccess: tier gating ══
  section('T2 — canAccess: tier gating');

  const fresh = { legalAccepted: false, userId: null, deviceId: null, hasSession: false };
  const legalOnly = { legalAccepted: true, userId: null, deviceId: null, hasSession: false };
  const fullSession = { legalAccepted: true, userId: 'u1', deviceId: 'd1', hasSession: true };

  for (const snap of [fresh, legalOnly, fullSession]) {
    t(`public accessible (snap=${JSON.stringify(snap)})`, canAccess(snap, 'public'));
  }
  t('legal_required blocked when no legal', !canAccess(fresh, 'legal_required'));
  t('legal_required allowed when legal accepted', canAccess(legalOnly, 'legal_required'));
  t('legal_required allowed when session exists', canAccess(fullSession, 'legal_required'));
  t('session_required blocked when fresh', !canAccess(fresh, 'session_required'));
  t('session_required blocked when legal-only', !canAccess(legalOnly, 'session_required'));
  t('session_required allowed with full session', canAccess(fullSession, 'session_required'));

  // ══ T3 — decideSplashAction ══
  section('T3 — decideSplashAction');

  t('fresh → /legal-acceptance', decideSplashAction(fresh) === '/legal-acceptance');
  t('legal-only → /phone-entry', decideSplashAction(legalOnly) === '/phone-entry');
  t('full session → /(tabs)', decideSplashAction(fullSession) === '/(tabs)');

  const partialSession = { legalAccepted: true, userId: 'u1', deviceId: null, hasSession: false };
  t('partial session (no deviceId) → /phone-entry', decideSplashAction(partialSession) === '/phone-entry');

  // ══ T4 — resolveSnapshot: fresh store ══
  section('T4 — resolveSnapshot: fresh store');

  const s1 = await resolveSnapshot(makeStore());
  t('fresh: legal not accepted', !s1.legalAccepted);
  t('fresh: no userId', s1.userId === null);
  t('fresh: no deviceId', s1.deviceId === null);
  t('fresh: no session', !s1.hasSession);

  // ══ T5 — resolveSnapshot: legal-only ══
  section('T5 — resolveSnapshot: legal-only');

  const s2 = await resolveSnapshot(makeStore({ [STORE_KEYS.LEGAL]: 'true' }));
  t('legal accepted', s2.legalAccepted);
  t('no session without userId+deviceId', !s2.hasSession);

  // ══ T6 — resolveSnapshot: full session ══
  section('T6 — resolveSnapshot: full session');

  const s3 = await resolveSnapshot(makeStore({
    [STORE_KEYS.LEGAL]: 'true',
    [STORE_KEYS.USER_ID]: 'user_abc',
    [STORE_KEYS.DEVICE_ID]: 'device_xyz',
    [STORE_KEYS.ACCESS_TOKEN]: 'tok_123',
    [STORE_KEYS.REFRESH_TOKEN]: 'ref_456',
    [STORE_KEYS.DISPLAY_PHONE]: '+14155551234',
    [STORE_KEYS.PHONE_NUMBER]: '+14155551234',
  }));
  t('full: legal accepted', s3.legalAccepted);
  t('full: userId set', s3.userId === 'user_abc');
  t('full: deviceId set', s3.deviceId === 'device_xyz');
  t('full: has session', s3.hasSession);

  // ══ T7 — partial: userId without deviceId ══
  section('T7 — partial session: userId without deviceId');

  const s4 = await resolveSnapshot(makeStore({
    [STORE_KEYS.LEGAL]: 'true',
    [STORE_KEYS.USER_ID]: 'user_abc',
  }));
  t('partial: no session without deviceId', !s4.hasSession);

  // ══ T8 — partial: deviceId without userId ══
  section('T8 — partial session: deviceId without userId');

  const s5 = await resolveSnapshot(makeStore({
    [STORE_KEYS.LEGAL]: 'true',
    [STORE_KEYS.DEVICE_ID]: 'device_xyz',
  }));
  t('partial: no session without userId', !s5.hasSession);

  // ══ T9 — fabricated userId blocked ══
  section('T9 — fabricated userId without deviceId blocked');

  const s6 = await resolveSnapshot(makeStore({
    [STORE_KEYS.LEGAL]: 'true',
    [STORE_KEYS.USER_ID]: 'attacker_id',
    [STORE_KEYS.DISPLAY_PHONE]: '+19999999999',
  }));
  t('fabricated: no session without deviceId', !s6.hasSession);
  t('fabricated: cannot access session_required', !canAccess(s6, 'session_required'));
  t('fabricated: can still access legal_required', canAccess(s6, 'legal_required'));

  // ══ T10 — anchor constant ══
  section('T10 — anchor constant');

  t('anchor route (index) is public tier', ROUTE_TIERS['index'] === 'public');

  // ══ T11 — splash CTA state-aware routing ══
  section('T11 — splash CTA state-aware routing');

  t('no legal → legal-acceptance', decideSplashAction(fresh) === '/legal-acceptance');
  t('legal only → phone-entry', decideSplashAction(legalOnly) === '/phone-entry');
  t('full session → /(tabs)', decideSplashAction(fullSession) === '/(tabs)');

  // ══ T12 — STORE_KEYS constants ══
  section('T12 — STORE_KEYS constants');

  t('LEGAL key correct', STORE_KEYS.LEGAL === 'onb.legalAccepted');
  t('USER_ID key correct', STORE_KEYS.USER_ID === 'userId');
  t('DEVICE_ID key correct', STORE_KEYS.DEVICE_ID === 'deviceId');
  t('ACCESS_TOKEN key correct', STORE_KEYS.ACCESS_TOKEN === 'accessToken');
  t('REFRESH_TOKEN key correct', STORE_KEYS.REFRESH_TOKEN === 'refreshToken');
  t('DISPLAY_PHONE key correct', STORE_KEYS.DISPLAY_PHONE === 'displayPhone');
  t('PHONE_NUMBER key correct', STORE_KEYS.PHONE_NUMBER === 'phoneNumber');
  t('LEGAL_VALUE is "true"', STORE_KEYS.LEGAL_VALUE === 'true');

  // ══ T13 — no-legal-value ≠ accepted ══
  section('T13 — no-legal-value ≠ accepted');

  const s7 = await resolveSnapshot(makeStore({ [STORE_KEYS.LEGAL]: 'yes' }));
  t('"yes" is not accepted', !s7.legalAccepted);

  const s8 = await resolveSnapshot(makeStore({ [STORE_KEYS.LEGAL]: '' }));
  t('empty string is not accepted', !s8.legalAccepted);

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
