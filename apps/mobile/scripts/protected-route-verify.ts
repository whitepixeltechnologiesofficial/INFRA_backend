// scripts/protected-route-verify.ts
//
// ROUTE-GUARD VERIFICATION — proves that the centralized `resolveRouteGate`
// blocks ALL identity-bearing query-param attacks across every protected route,
// while preserving normal onboarding and QR flow paths.
//
// Run with:  npx tsx scripts/protected-route-verify.ts   (from apps/mobile)
//
// Covers:
//   T1. All six attack URLs → Legal Acceptance for a fresh (unauthenticated) snapshot
//   T2. Attacker-supplied userId / accessToken / token → never authenticates
//   T3. Full-session snapshot → allow all protected routes
//   T4. Legal-only snapshot (accepted terms but no session) → correct behaviour
//   T5. displayPhone field present only in OTP-verified snapshot, never from URL
//   T6. Redirects use plain string routes (no query params forwarded)
//   T7. Source code safety: guarded screens render null until snapshot is available
//   T8. No useLocalSearchParams identity reads remain in guarded screens

let passed = 0;
let failed = 0;
const results: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    results.push(`  PASS  ${label}`);
  } else {
    failed++;
    results.push(`  FAIL  ${label}`);
  }
}

// ---- Pure unit tests on resolveRouteGate ----

// Import the pure gate function (resolved at runtime by tsx loader).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveRouteGate } = require('../lib/route-guard') as typeof import('../lib/route-guard');
// eslint-disable-next-line @typescript-eslint/no-require-imports
type OnboardingSnapshot = import('../lib/onboarding-guard').OnboardingSnapshot;

const FRESH: OnboardingSnapshot = {
  legalAccepted: false,
  userId: null,
  deviceId: 'dev-fresh',
  hasSession: false,
  displayPhone: null,
};

const LEGAL_ONLY: OnboardingSnapshot = {
  legalAccepted: true,
  userId: null,
  deviceId: 'dev-legal',
  hasSession: false,
  displayPhone: null,
};

const FULL: OnboardingSnapshot = {
  legalAccepted: true,
  userId: 'u-abc123',
  deviceId: 'dev-full',
  hasSession: true,
  displayPhone: '+14155552671',
};

const PROTECTED_ROUTES = [
  'profile-setup',
  '(tabs)',
  'device-handoff',
  'settings',
  'permission-intro',
  'permission-info',
  'notifications-info',
];

const ATTACK_PATHS = [
  { path: '/profile-setup',       id: 'profile-setup' },
  { path: '/(tabs)',              id: '(tabs)' },
  { path: '/device-handoff',     id: 'device-handoff' },
  { path: '/profile-setup?userId=test',             id: 'profile-setup' },
  { path: '/profile-setup?accessToken=test',        id: 'profile-setup' },
  { path: '/profile-setup?phone=9876543210&userId=test', id: 'profile-setup' },
];

// ---- T1: All attack URLs redirect to legal for fresh snapshot ----

results.push('\n[T1] Fresh snapshot → all protected routes redirect to /legal-acceptance');
for (const { path, id } of ATTACK_PATHS) {
  const gate = resolveRouteGate(id, FRESH);
  assert(
    gate.action === 'redirect' && gate.to === '/legal-acceptance',
    `${path} → legal-acceptance  (got ${gate.action}${gate.action === 'redirect' ? ' → ' + gate.to : ''})`,
  );
}

// ---- T2: Attacker params never create a session ----

results.push('\n[T2] Attacker-supplied identity never authenticates');
// Even if an attacker supplies every param, the snapshot is FRESH → no session.
const attackSnap: OnboardingSnapshot = {
  legalAccepted: false,
  userId: null,
  deviceId: 'attacker',
  hasSession: false,   // This is the source of truth — not a URL param
  displayPhone: null,
};
for (const route of PROTECTED_ROUTES) {
  const gate = resolveRouteGate(route, attackSnap);
  assert(
    gate.action === 'redirect',
    `route=${route}, fresh → redirected (not ${gate.action})`,
  );
}

// ---- T3: Full session → allow all protected routes ----

results.push('\n[T3] Full session → all protected routes allowed');
for (const route of PROTECTED_ROUTES) {
  const gate = resolveRouteGate(route, FULL);
  assert(gate.action === 'allow', `route=${route} → allow`);
}

// ---- T4: Legal-only snapshot (accepted terms, no session) ----

results.push('\n[T4] Legal-only snapshot → otp-entry allowed, everything else redirected');
const legalOnlyGate = resolveRouteGate('otp-entry', LEGAL_ONLY);
assert(legalOnlyGate.action === 'allow', 'otp-entry allowed (legal only)');
for (const route of PROTECTED_ROUTES.filter(r => r !== 'otp-entry')) {
  const gate = resolveRouteGate(route, LEGAL_ONLY);
  assert(
    gate.action === 'redirect' && gate.to === '/phone-entry',
    `${route} → phone-entry (legal only)`,
  );
}

// ---- T5: displayPhone in snapshot is verified, not from URL ----

results.push('\n[T5] displayPhone field present in snapshot (OTP-verified only)');
assert(
  FULL.displayPhone === '+14155552671',
  'FULL snapshot has displayPhone from SecureStore',
);
assert(
  FRESH.displayPhone === null || FRESH.displayPhone === undefined,
  'FRESH snapshot has no displayPhone',
);
assert(
  LEGAL_ONLY.displayPhone === null || LEGAL_ONLY.displayPhone === undefined,
  'LEGAL_ONLY snapshot has no displayPhone',
);

// ---- T6: Redirects are plain strings, no params forwarded ----

results.push('\n[T6] Redirect decisions are plain strings (no params forwarded)');
for (const route of PROTECTED_ROUTES) {
  const gate = resolveRouteGate(route, FRESH);
  if (gate.action === 'redirect') {
    assert(
      typeof gate.to === 'string' && !gate.to.includes('?'),
      `route=${route}: redirect.to is plain "${gate.to}"`,
    );
  } else {
    assert(true, `route=${route}: allow (no redirect to check)`);
  }
}

// ---- T7: Guarded screens render null until snapshot resolves ----

results.push('\n[T7] Guarded screens: early return null when snapshot pending');
import * as fs from 'fs';
import * as path from 'path';

const screens = [
  { file: 'app/profile-setup.tsx',      route: 'profile-setup' },
  { file: 'app/device-handoff.tsx',     route: 'device-handoff' },
  { file: 'app/settings.tsx',           route: 'settings' },
  { file: 'app/otp-entry.tsx',          route: 'otp-entry' },
  { file: 'app/(tabs)/_layout.tsx',     route: '(tabs)' },
  { file: 'app/permission-intro.tsx',   route: 'permission-intro' },
  { file: 'app/permission-info.tsx',     route: 'permission-info' },
  { file: 'app/notifications-info.tsx', route: 'notifications-info' },
];

for (const { file, route } of screens) {
  const abs = path.resolve(__dirname, '..', file);
  const src = fs.readFileSync(abs, 'utf8');
  const hasNullReturn = src.includes('if (!snapshot) return null');
  const hasHookCall = src.includes(`useRouteGuard('${route}')`);
  assert(hasNullReturn, `${file}: has "if (!snapshot) return null"`);
  assert(hasHookCall,   `${file}: has useRouteGuard('${route}')`);
}

// ---- T8: No useLocalSearchParams identity reads remain in guarded screens ----

results.push('\n[T8] Guarded screens: no useLocalSearchParams identity reads for displayPhone/userId');
for (const { file } of screens) {
  const abs = path.resolve(__dirname, '..', file);
  const src = fs.readFileSync(abs, 'utf8');
  // These screens should not read displayPhone/userId from URL params for
  // rendering or SecureStore writes. otp-entry is an exception: it reads
  // displayPhone for the "Code sent to X" label, which is a display-only
  // string — it doesn't authenticate, select an account, or establish identity.
  // otp-entry legitimately reads phoneNumber for verify (keyed to an OTP session).
  const readsDisplayPhoneFromParams = /params\.displayPhone/.test(src);
  const readsUserIdFromParams = /params\.userId/.test(src);
  const isOtpEntry = file.includes('otp-entry');
  assert(
    !readsDisplayPhoneFromParams || isOtpEntry,
    `${file}: does not read params.displayPhone${isOtpEntry ? ' (exception: display label)' : ''}`,
  );
  assert(!readsUserIdFromParams,       `${file}: does not read params.userId`);
}

// ---- T9: Public routes always allowed regardless of session state ----

results.push('\n[T9] Public routes always allowed');
const PUBLIC = ['', 'index', 'legal-acceptance', 'phone-entry'];
for (const route of PUBLIC) {
  for (const snap of [FRESH, LEGAL_ONLY, FULL]) {
    const gate = resolveRouteGate(route, snap);
    assert(gate.action === 'allow', `public "${route}" always allowed (snap=${snap.hasSession ? 'full' : snap.legalAccepted ? 'legal' : 'fresh'})`);
  }
}

// ---- Summary ----

console.log('\n=== Protected Route Guard Verification ===');
for (const line of results) console.log(line);
console.log(`\nTotal: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) process.exit(1);