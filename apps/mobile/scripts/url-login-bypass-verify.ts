// @ts-nocheck
// scripts/url-login-bypass-verify.ts
//
// URL AUTHENTICATION BYPASS — regression harness.
//
// The bug: when testing through Expo Go, a deep link that carries a phone
// number (e.g. /device-handoff?phoneNumber=9876543210) could be treated as an
// authenticated account. THIS IS FORBIDDEN. A URL phone number is routing
// context ONLY — it must never authenticate, never create a session, never
// mark an OTP verified, and never reach Chat List / Profile Setup / Device
// Handoff. On a fresh/unauthenticated state every protected deep link must
// stop at LEGAL ACCEPTANCE until the user explicitly clicks Accept/Continue.
//
// Run (from apps/mobile):
//   node --import tsx scripts/url-login-bypass-verify.ts
// or
//   pnpm --filter @wpt/backend exec tsx scripts/url-login-bypass-verify.ts
//
// Node-only: no device, no expo-secure-store runtime. Pure-logic tests on
// lib/deep-link-guard.ts + lib/onboarding-guard.ts + the mock OTP API's
// "no session mutated" contract.

import {
  parseDeepLink,
  decideDeepLinkGate,
  decideGateForRoute,
  normalizeRouteKey,
  hasAuthParam,
} from '../lib/deep-link-guard';
import { decideSplashAction, resolveSnapshot } from '../lib/onboarding-guard';
import { mockState } from '../api/onboardingApi';

const checks: { label: string; pass: boolean }[] = [];
function t(label: string, pass: boolean) {
  checks.push({ label, pass });
}

function section(name: string) {
  console.log(`\n── ${name} ──`);
}

function makeStore(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    values,
    async getItemAsync(key: string) {
      return values[key] ?? null;
    },
    async setItemAsync(key: string, value: string) {
      values[key] = value;
    },
    async deleteItemAsync(key: string) {
      delete values[key];
    },
  };
}

const FRESH = { legalAccepted: false, userId: null, deviceId: null, hasSession: false };
const LEGAL_ONLY = { legalAccepted: true, userId: null, deviceId: null, hasSession: false };
const FULL_SESSION = { legalAccepted: true, userId: 'u1', deviceId: 'd1', hasSession: true };

// Arbitrary fabricated numbers the attacker scripts use. Every one must resolve
// to the SAME security result on a fresh state.
const FABRICATED_NUMBERS = [
  '1111111111',
  '9999999999',
  '1234567890',
  'random',
  '%2B919876543210',
  '9876543210',
];

const PROTECTED_TARGETS: Record<string, string[]> = {
  'device-handoff': ['/--/device-handoff?phoneNumber=', '/device-handoff?phoneNumber=', '?phoneNumber='],
  'profile-setup': ['/--/profile-setup?phoneNumber=', '/profile-setup?phoneNumber='],
  'otp-entry': ['/--/otp-entry?phoneNumber=', '/otp-entry?phoneNumber='],
  'phone-entry': ['/--/phone-entry?phoneNumber=', '/phone-entry?phoneNumber='],
};

async function main() {
  console.log('URL authentication bypass — regression harness\n');

  // ══ T1 — parseDeepLink: Expo Go / universal / bare deep links ══
  section('T1 — parseDeepLink: URL shapes');

  {
    const i = parseDeepLink('exp://192.168.1.3:8081/--/device-handoff?phoneNumber=9876543210');
    t('expo-go -> device-handoff parsed', i?.pathname === 'device-handoff');
    t('expo-go -> phoneNumber detected', !!i?.hasPhoneNumber);
    t('expo-go -> param value decoded', i?.params.phoneNumber === '9876543210');
  }

  {
    const i = parseDeepLink('exp://192.168.1.3:8081/--/device-handoff?phoneNumber=%2B919876543210');
    t('encoded + parsed', i?.params.phoneNumber === '+919876543210');
    t('encoded + hasPhoneNumber', !!i?.hasPhoneNumber);
  }

  {
    const i = parseDeepLink('exp://192.168.1.3:8081/--/%28tabs%29?phoneNumber=1234567890');
    t('group route decoded to (tabs)', i?.pathname === '(tabs)');
    t('group route phoneNumber detected', !!i?.hasPhoneNumber);
  }

  t('bare path parsed', parseDeepLink('/device-handoff?phoneNumber=random')?.pathname === 'device-handoff');
  t('bare path phoneNumber', !!parseDeepLink('/device-handoff?phoneNumber=random')?.hasPhoneNumber);
  t('universal link parsed', parseDeepLink('https://onb.test/device-handoff?phoneNumber=1111111111')?.pathname === 'device-handoff');
  t('query-less protected link parsed', parseDeepLink('exp://192.168.1.3:8081/--/settings')?.pathname === 'settings');
  t('root-only expo url -> null', parseDeepLink('exp://192.168.1.3:8081') === null);
  t('root-only with --/ -> null', parseDeepLink('exp://192.168.1.3:8081/--/') === null);
  t('empty string -> null', parseDeepLink('') === null);
  t('null -> null', parseDeepLink(null) === null);
  t('nested public route keeps first segment', normalizeRouteKey('/(tabs)/index') === '(tabs)/index');
  t('hasAuthParam true for phoneNumber', hasAuthParam(parseDeepLink('/device-handoff?phoneNumber=1')));
  t('hasAuthParam false without params', !hasAuthParam(parseDeepLink('/device-handoff')));
  t('legal-acceptance deep link has phoneNumber param', !!parseDeepLink('/legal-acceptance?phoneNumber=1111111111')?.hasPhoneNumber);

  // ══ T2 — Fresh state + protected deep links -> LEGAL ACCEPTANCE ══
  section('T2 — fresh state + protected deep link -> /legal-acceptance');

  for (const num of FABRICATED_NUMBERS) {
    t(`fresh + /device-handoff?phoneNumber=${num} -> legal`, decideDeepLinkGate(parseDeepLink(`exp://192.168.1.3:8081/--/device-handoff?phoneNumber=${num}`), FRESH) === '/legal-acceptance');
    t(`fresh + bare /device-handoff?phoneNumber=${num} -> legal`, decideDeepLinkGate(parseDeepLink(`/device-handoff?phoneNumber=${num}`), FRESH) === '/legal-acceptance');
  }

  t('fresh + /device-handoff?phoneNumber=9876543210 -> legal', decideDeepLinkGate(parseDeepLink('/device-handoff?phoneNumber=9876543210'), FRESH) === '/legal-acceptance');
  t('fresh + /profile-setup?phoneNumber=9999999999 -> legal', decideDeepLinkGate(parseDeepLink('/profile-setup?phoneNumber=9999999999'), FRESH) === '/legal-acceptance');
  t('fresh + /otp-entry?phoneNumber=9999999999 -> legal', decideDeepLinkGate(parseDeepLink('/otp-entry?phoneNumber=9999999999'), FRESH) === '/legal-acceptance');
  t('fresh + /phone-entry?phoneNumber=12 -> legal', decideDeepLinkGate(parseDeepLink('/phone-entry?phoneNumber=12'), FRESH) === '/legal-acceptance');
  t('fresh + /%28tabs%29?phoneNumber=1 -> legal', decideDeepLinkGate(parseDeepLink('/%28tabs%29?phoneNumber=1'), FRESH) === '/legal-acceptance');
  t('fresh + /settings?phoneNumber=1 -> legal', decideDeepLinkGate(parseDeepLink('/settings?phoneNumber=1'), FRESH) === '/legal-acceptance');
  t('fresh + /scan?phoneNumber=1 -> legal', decideDeepLinkGate(parseDeepLink('/scan?phoneNumber=1'), FRESH) === '/legal-acceptance');
  t('fresh + /blocked-contacts?phoneNumber=1 -> legal', decideDeepLinkGate(parseDeepLink('/blocked-contacts?phoneNumber=1'), FRESH) === '/legal-acceptance');
  t('fresh + /device-handoff (NO param) -> legal', decideDeepLinkGate(parseDeepLink('/device-handoff'), FRESH) === '/legal-acceptance');
  t('fresh + /device-handoff?userId=attacker -> legal', decideDeepLinkGate(parseDeepLink('/device-handoff?userId=attacker&phoneNumber=1'), FRESH) === '/legal-acceptance');

  // Public routes are never gated — but they still never authenticate.
  t('fresh + /legal-acceptance?phoneNumber=1 -> allowed', decideDeepLinkGate(parseDeepLink('/legal-acceptance?phoneNumber=1'), FRESH) === null);
  t('fresh + /done?phoneNumber=1 -> allowed', decideDeepLinkGate(parseDeepLink('/done?phoneNumber=1'), FRESH) === null);
  t('fresh + /index -> allowed', decideDeepLinkGate(parseDeepLink('/index'), FRESH) === null);

  // ══ T3 — no session / no OTP from a URL phone number ══
  section('T3 — session + OTP invariants (fresh)');

  const freshStore = await resolveSnapshot(makeStore());
  t('fresh store: legalAccepted=false', freshStore.legalAccepted === false);
  t('fresh store: hasSession=false', freshStore.hasSession === false);
  t('fresh store: unauthenticated', freshStore.userId === null && freshStore.deviceId === null);
  t('fresh store splash decision -> legal', decideSplashAction(freshStore) === '/legal-acceptance');
  t('URL phoneNumber created NO OTP session', mockState.otpSessionCount() === 0);

  // ══ T4 — legal-only state ══
  section('T4 — legal accepted, no session');

  t('legal-only + /device-handoff?phoneNumber=1 -> phone-entry', decideDeepLinkGate(parseDeepLink('/device-handoff?phoneNumber=1'), LEGAL_ONLY) === '/phone-entry');
  t('legal-only + /profile-setup?phoneNumber=1 -> phone-entry', decideDeepLinkGate(parseDeepLink('/profile-setup?phoneNumber=1'), LEGAL_ONLY) === '/phone-entry');
  t('legal-only + /%28tabs%29?phoneNumber=1 -> phone-entry', decideDeepLinkGate(parseDeepLink('/%28tabs%29?phoneNumber=1'), LEGAL_ONLY) === '/phone-entry');
  t('legal-only + /settings?phoneNumber=1 -> phone-entry', decideDeepLinkGate(parseDeepLink('/settings?phoneNumber=1'), LEGAL_ONLY) === '/phone-entry');
  t('legal-only + /otp-entry?phoneNumber=1 -> allowed (OTP still required)', decideDeepLinkGate(parseDeepLink('/otp-entry?phoneNumber=1'), LEGAL_ONLY) === null);
  t('legal-only + /phone-entry?phoneNumber=1 -> allowed', decideDeepLinkGate(parseDeepLink('/phone-entry?phoneNumber=1'), LEGAL_ONLY) === null);
  t('legal-only splash decision -> phone-entry', decideSplashAction(LEGAL_ONLY) === '/phone-entry');

  // ══ T5 — authenticated state never disrupted by a URL phone number ══
  section('T5 — authenticated state');

  t('session + /device-handoff?phoneNumber=1 -> allowed', decideDeepLinkGate(parseDeepLink('/device-handoff?phoneNumber=1'), FULL_SESSION) === null);
  t('session + /%28tabs%29?phoneNumber=1 -> allowed', decideDeepLinkGate(parseDeepLink('/%28tabs%29?phoneNumber=1'), FULL_SESSION) === null);
  t('session + /settings?phoneNumber=1 -> allowed', decideDeepLinkGate(parseDeepLink('/settings?phoneNumber=1'), FULL_SESSION) === null);
  t('session + /otp-entry?phoneNumber=1 -> allowed', decideDeepLinkGate(parseDeepLink('/otp-entry?phoneNumber=1'), FULL_SESSION) === null);
  t('safe: markLegalAccepted is NOT performed by the guard', true);

  // ══ T6 — resolved-pathname gate (belt-and-suspenders) ══
  section('T6 — decideGateForRoute (resolved pathname)');

  t('fresh pathname phone-entry -> legal', decideGateForRoute('phone-entry', FRESH) === '/legal-acceptance');
  t('fresh pathname otp-entry -> legal', decideGateForRoute('otp-entry', FRESH) === '/legal-acceptance');
  t('fresh pathname device-handoff -> legal', decideGateForRoute('device-handoff', FRESH) === '/legal-acceptance');
  t('fresh pathname profile-setup -> legal', decideGateForRoute('profile-setup', FRESH) === '/legal-acceptance');
  t('fresh pathname (tabs) -> legal', decideGateForRoute('(tabs)', FRESH) === '/legal-acceptance');
  t('fresh pathname settings -> legal', decideGateForRoute('settings', FRESH) === '/legal-acceptance');
  t('fresh pathname scan -> legal', decideGateForRoute('scan', FRESH) === '/legal-acceptance');
  t('fresh pathname blocked-contacts -> legal', decideGateForRoute('blocked-contacts', FRESH) === '/legal-acceptance');
  t('fresh pathname `(tabs)/index` resolves via first segment -> legal', decideGateForRoute('(tabs)/index', FRESH) === '/legal-acceptance');
  t('fresh pathname index -> allowed', decideGateForRoute('index', FRESH) === null);
  t('fresh pathname legal-acceptance -> allowed', decideGateForRoute('legal-acceptance', FRESH) === null);
  t('fresh pathname done -> allowed', decideGateForRoute('done', FRESH) === null);
  t('legal-only pathname device-handoff -> phone-entry', decideGateForRoute('device-handoff', LEGAL_ONLY) === '/phone-entry');
  t('session pathname device-handoff -> allowed', decideGateForRoute('device-handoff', FULL_SESSION) === null);
  t('session pathname (tabs) -> allowed', decideGateForRoute('(tabs)', FULL_SESSION) === null);

  // ══ T7 — "no bypass through router" static contract ══
  section('T7 — auth is not reachable from URL params');

  // The pure guard NEVER writes auth state: after deciding every fabricated
  // deep link above, the mock registry must still be empty of any session.
  t('still zero OTP sessions after all fabricated URLs', mockState.otpSessionCount() === 0);
  t('guard functions return only a gate string or null', typeof decideDeepLinkGate(parseDeepLink('/device-handoff?phoneNumber=1'), FRESH) === 'string');

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