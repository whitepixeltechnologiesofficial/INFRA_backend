// scripts/qr-scan-verify.ts
//
// QR / DEEP-LINK AUTHENTICATION — regression harness.
//
// A scanned QR payload is untrusted, attacker-controlled input. It is ROUTING
// CONTEXT ONLY and must NEVER authenticate a phone number, create a session or
// mark an OTP verified. The tester's repro: "scanning the provided QR code
// logs the user into phone 9876543210." Each adversarial URL shape below must
// resolve to gate / block — never to an authenticated route, and never touch
// the mock session/OTP registries.
//
// Layer 1 — provenance: browser URLs open ONLY for trusted destinations
//   (configured origins + localhost/RFC1918 LAN). Public hosts (e.g.
//   example.com) are blocked.
// Layer 2 — gating: scanned values that resolve to one of the app's own routes
//   (wptmobile://, exp://, https universal, bare path) go through
//   decideGateForRoute with the SecureStore snapshot — same decision the root
//   DeepLinkGuard uses. A URL phone number never creates a session.
//
// Run (from apps/mobile):
//   node --import tsx scripts/qr-scan-verify.ts
//
// Node-only: no device, no camera, no expo-secure-store runtime.

import { parseDeepLink, hasAuthParam, hasAppRoute } from '../lib/deep-link-guard';
import {
  buildAllowedBrowserOrigins,
  classifyScannedLink,
  decideScannedLinkAction,
  isHttpUrl,
  isPrivateLanHostname,
  isTrustedBrowserOrigin,
  normalizeOrigin,
} from '../lib/qr-link';
import { onboardingApi, mockState } from '../api/onboardingApi';

const checks: { label: string; pass: boolean }[] = [];
function t(label: string, pass: boolean) {
  checks.push({ label, pass });
}

function section(name: string) {
  console.log(`\n── ${name} ──`);
}

const FRESH = { legalAccepted: false, userId: null, deviceId: null, hasSession: false };
const LEGAL_ONLY = { legalAccepted: true, userId: null, deviceId: null, hasSession: false };
const FULL_SESSION = { legalAccepted: true, userId: 'u1', deviceId: 'd1', hasSession: true };

const NO_ORIGINS: string[] = [];
const WITH_HOST = buildAllowedBrowserOrigins({ EXPO_PUBLIC_QR_LINK_HOSTS: 'https://wpt.example' });

function isGate(d: ReturnType<typeof decideScannedLinkAction>, kind: 'legal' | 'phone-entry') {
  return d.action === 'gate_to' && d.gate === (kind === 'legal' ? '/legal-acceptance' : '/phone-entry');
}
function isOpen(route: string, d: ReturnType<typeof decideScannedLinkAction>) {
  return d.action === 'open_app_route' && d.intent.pathname === route;
}
function isBlockedHost(d: ReturnType<typeof decideScannedLinkAction>) {
  return d.action === 'block' && d.reason === 'unsupported_host';
}
function isBrowser(url: string, d: ReturnType<typeof decideScannedLinkAction>) {
  return d.action === 'open_browser' && d.url === url;
}

async function main() {
  console.log('QR scan / deep-link authentication — regression harness\n');

  // ══ A — custom-scheme deep links now resolve (wptmobile://) ══
  section('A — custom-scheme deep-link parsing');

  t('wptmobile://settings resolves', parseDeepLink('wptmobile://settings')?.pathname === 'settings');
  t('wptmobile://otp-entry carries phoneNumber', parseDeepLink('wptmobile://otp-entry?phoneNumber=9876543210')?.hasPhoneNumber === true);
  t('wptmobile://%28tabs%29 decodes to (tabs)', parseDeepLink('wptmobile://%28tabs%29?phoneNumber=1')?.pathname === '(tabs)');
  t('generic custom scheme host-as-route', parseDeepLink('sms://123?next=/x')?.pathname === '123');
  t('bare wptmobile:// -> null', parseDeepLink('wptmobile://') === null);
  t('custom scheme is NOT a browser URL', isHttpUrl('wptmobile://settings') === false);
  t('hasAppRoute settings', hasAppRoute('settings') === true);
  t('hasAppRoute (tabs)', hasAppRoute('(tabs)') === true);
  t('hasAppRoute NOT for web /phone/link/<token>', hasAppRoute('phone/link/token') === false);
  t('hasAppRoute NOT for a bare number path', hasAppRoute('9876543210') === false);
  t('hasAuthParam true on wptmobile link', hasAuthParam(parseDeepLink('wptmobile://otp-entry?phoneNumber=9876543210')) === true);
  t('regression: https universal link', parseDeepLink('https://onb.test/device-handoff?phoneNumber=1')?.pathname === 'device-handoff');
  t('regression: exp --/ marker', parseDeepLink('exp://192.168.1.3:8081/--/profile-setup')?.pathname === 'profile-setup');
  t('regression: bare path', parseDeepLink('/phone-entry')?.pathname === 'phone-entry');
  t('regression: root public URL -> null', parseDeepLink('https://example.com/?phone=9876543210') === null);

  // ══ T1 — phone in QUERY params must never authenticate ══
  section('T1 — https://example.com/?phone=9876543210 -> NEVER authenticates');
  {
    const url = 'https://example.com/?phone=9876543210';
    const cls = classifyScannedLink(url);
    t('classified as browser_url (not an app route)', cls.kind === 'browser_url');
    const f = decideScannedLinkAction(url, FRESH, NO_ORIGINS);
    const l = decideScannedLinkAction(url, LEGAL_ONLY, NO_ORIGINS);
    const s = decideScannedLinkAction(url, FULL_SESSION, NO_ORIGINS);
    t('fresh: blocked (public host)', isBlockedHost(f));
    t('legal-only: blocked (public host)', isBlockedHost(l));
    t('authenticated: still blocked (URL is never an app route / auth)', isBlockedHost(s));
    t('never open_browser on a public host', !isBrowser(url, f) && !isBrowser(url, l) && !isBrowser(url, s));
    t('never an app route (no navigation)', !isOpen('otp-entry', f) && !isOpen('(tabs)', s));
  }

  // ══ T2 — encoded E.164 in query params must never authenticate ══
  section('T2 — https://example.com/?phone=%2B919876543210 -> NEVER authenticates');
  {
    const url = 'https://example.com/?phone=%2B919876543210';
    const cls = classifyScannedLink(url);
    t('classified as browser_url', cls.kind === 'browser_url');
    t('fresh: blocked', isBlockedHost(decideScannedLinkAction(url, FRESH, NO_ORIGINS)));
    t('authenticated: blocked', isBlockedHost(decideScannedLinkAction(url, FULL_SESSION, NO_ORIGINS)));
    const i = parseDeepLink('exp://192.168.1.3:8081/--/otp-entry?phoneNumber=%2B919876543210');
    t('decode still yields +919876543210 (...) ', i?.params.phoneNumber === '+919876543210');
    t('(...) but fresh still gates to legal', i ? isGate(decideScannedLinkAction(`exp://h/--/otp-entry?phoneNumber=${i.params.phoneNumber}`, FRESH, NO_ORIGINS), 'legal') : false);
    t('registered-number deep link does NOT bypass on legal-only (OTP still needed)', isOpen('otp-entry', decideScannedLinkAction('exp://h/--/otp-entry?phoneNumber=%2B919876543210', LEGAL_ONLY, NO_ORIGINS)));
  }

  // ══ T3 — phone in PATH must never authenticate ══
  section('T3 — phone in path -> NEVER authenticates');
  {
    t('plain number path is browser_url -> blocked', isBlockedHost(decideScannedLinkAction('https://example.com/9876543210', FULL_SESSION, NO_ORIGINS)));
    t('another number path -> blocked', isBlockedHost(decideScannedLinkAction('https://example.com/4155552671', FULL_SESSION, NO_ORIGINS)));
    t('exp device-handoff + number: fresh -> legal', isGate(decideScannedLinkAction('exp://192.168.1.3:8081/--/device-handoff?phoneNumber=9876543210', FRESH, NO_ORIGINS), 'legal'));
    t('universal (tabs) + phone: fresh -> legal', isGate(decideScannedLinkAction('https://onb.test/%28tabs%29?phone=9876543210', FRESH, NO_ORIGINS), 'legal'));
    const s = decideScannedLinkAction('https://onb.test/%28tabs%29?phone=9876543210', FULL_SESSION, NO_ORIGINS);
    t('universal (tabs) + phone: authenticated -> route param only (no new session)', isOpen('(tabs)', s));
  }

  // ══ T4 — unauthenticated app deep link -> gate, never Chat List ══
  section('T4 — unauthenticated deep links bounce to the onboarding gate');
  for (const num of ['1111111111', '9999999999', '1234567890', 'random', '%2B919876543210', '9876543210']) {
    t(`fresh + wptmobile://profile-setup?phoneNumber=${num} -> legal`, isGate(decideScannedLinkAction(`wptmobile://profile-setup?phoneNumber=${num}`, FRESH, NO_ORIGINS), 'legal'));
    t(`fresh + exp --/device-handoff?phoneNumber=${num} -> legal`, isGate(decideScannedLinkAction(`exp://192.168.1.3:8081/--/device-handoff?phoneNumber=${num}`, FRESH, NO_ORIGINS), 'legal'));
  }
  t('fresh + wptmobile://(tabs) -> legal', isGate(decideScannedLinkAction('wptmobile://(tabs)', FRESH, NO_ORIGINS), 'legal'));
  t('fresh + /otp-entry?phoneNumber=9999999999 -> legal', isGate(decideScannedLinkAction('/otp-entry?phoneNumber=9999999999', FRESH, NO_ORIGINS), 'legal'));
  t('fresh + /phone-entry?phoneNumber=12 -> legal', isGate(decideScannedLinkAction('/phone-entry?phoneNumber=12', FRESH, NO_ORIGINS), 'legal'));
  t('legal-only + wptmobile://profile-setup -> phone-entry', isGate(decideScannedLinkAction('wptmobile://profile-setup?phoneNumber=9876543210', LEGAL_ONLY, NO_ORIGINS), 'phone-entry'));
  t('legal-only + /device-handoff -> phone-entry', isGate(decideScannedLinkAction('/device-handoff?phoneNumber=1', LEGAL_ONLY, NO_ORIGINS), 'phone-entry'));
  t('legal-only + /(tabs) -> phone-entry', isGate(decideScannedLinkAction('/(tabs)?phone=1', LEGAL_ONLY, NO_ORIGINS), 'phone-entry'));
  t('legal-only + /otp-entry -> open (OTP still mandatory)', isOpen('otp-entry', decideScannedLinkAction('/otp-entry?phoneNumber=1', LEGAL_ONLY, NO_ORIGINS)));
  t('legal-only + /phone-entry -> open (manual entry only)', isOpen('phone-entry', decideScannedLinkAction('/phone-entry?phoneNumber=1', LEGAL_ONLY, NO_ORIGINS)));

  // ══ T5 — authenticated user's normal deep links still work ══
  section('T5 — authenticated deep links unchanged');
  {
    t('wptmobile://settings open', isOpen('settings', decideScannedLinkAction('wptmobile://settings', FULL_SESSION, NO_ORIGINS)));
    t('https universal /settings open', isOpen('settings', decideScannedLinkAction('https://onb.test/settings', FULL_SESSION, NO_ORIGINS)));
    t('/(tabs) open', isOpen('(tabs)', decideScannedLinkAction('/(tabs)', FULL_SESSION, NO_ORIGINS)));
    t('/scan open', isOpen('scan', decideScannedLinkAction('/scan', FULL_SESSION, NO_ORIGINS)));
    t('exp --/settings open', isOpen('settings', decideScannedLinkAction('exp://192.168.1.3:8081/--/settings', FULL_SESSION, NO_ORIGINS)));
  }

  // ══ T6 — intended LAN browser destination still opens ══
  section('T6 — intended destinations open; only intended destinations');
  {
    const lan = 'http://192.168.1.20:3000/phone/link/abc123';
    t('LAN qr-login link trusted + URL preserved', isBrowser(lan, decideScannedLinkAction(lan, FULL_SESSION, NO_ORIGINS)));
    t('10.x LAN trusted', isBrowser('http://10.0.0.5:3000/phone/link/t', decideScannedLinkAction('http://10.0.0.5:3000/phone/link/t', FRESH, NO_ORIGINS)));
    t('172.16-31 LAN trusted', isBrowser('http://172.20.1.1:3000/x', decideScannedLinkAction('http://172.20.1.1:3000/x', FRESH, NO_ORIGINS)));
    t('172.32 out of range NOT trusted', isBlockedHost(decideScannedLinkAction('http://172.32.0.1:3000/x', FRESH, NO_ORIGINS)));
    t('localhost trusted', isBrowser('http://localhost:3000/x', decideScannedLinkAction('http://localhost:3000/x', FRESH, NO_ORIGINS)));
    t('public host blocked without config', isBlockedHost(decideScannedLinkAction('https://wpt.example/x', FRESH, NO_ORIGINS)));
    t('public host allowed when configured', isBrowser('https://wpt.example/x', decideScannedLinkAction('https://wpt.example/x', FRESH, WITH_HOST)));
    t('public host (other) still blocked', isBlockedHost(decideScannedLinkAction('https://other.example/x', FRESH, WITH_HOST)));
  }

  // ══ T7 — nothing above ever mutated auth state ══
  section('T7 — QR decisions never touched auth state');
  {
    t('zero OTP sessions created by any QR decision', mockState.otpSessionCount() === 0);
    t('no legal acceptance recorded by any QR decision', mockState.acceptedLegalNumbers.size === 0);
    const lanPhish = 'http://192.168.1.20:3000/?phone=%2B919876543210';
    t('LAN browser open with identity param: still open_browser', isBrowser(lanPhish, decideScannedLinkAction(lanPhish, FULL_SESSION, NO_ORIGINS)));
    t('...but it created no session', mockState.otpSessionCount() === 0 && mockState.acceptedLegalNumbers.size === 0);
    t('registered-number wptmobile link: fresh -> legal', isGate(decideScannedLinkAction('wptmobile://otp-entry?phoneNumber=%2B919876543210', FRESH, NO_ORIGINS), 'legal'));
  }

  // ══ T8 — legitimate manual login unchanged + mock registered numbers intact ══
  section('T8 — legitimate manual login still works (Team Alpha preserved)');
  {
    mockState.clearAll();
    await onboardingApi.acceptLegal('+919876543210');
    await onboardingApi.sendOtp({ phoneNumber: '+919876543210' });
    const ok = await onboardingApi.verifyOtp({ phoneNumber: '+919876543210', code: '123456', deviceId: 'd1' });
    t('manual login succeeds', ok.status === 'success');
    t('registered number routes to chats', ok.status === 'success' && ok.routing === 'chats');
    t('session tokens minted', ok.status === 'success' && !!ok.accessToken && !!ok.userId);
    t('registered numbers list still contains +919876543210', (await onboardingApi.checkExistingUser({ phoneNumber: '+919876543210' })).exists);
    t('other registered numbers preserved', (await onboardingApi.checkExistingUser({ phoneNumber: '+14155552671' })).exists === true);
    let threw = false;
    try {
      await onboardingApi.verifyOtp({ phoneNumber: '+911234567890', code: '123456' });
    } catch (e) {
      threw = (e as Error).message === 'NO_ACTIVE_SESSION';
    }
    t('verify without a sent OTP still rejected (NO_ACTIVE_SESSION)', threw);
    t('fresh number login still requires profile setup routing', (await (async () => {
      await onboardingApi.acceptLegal('+15550123');
      await onboardingApi.sendOtp({ phoneNumber: '+15550123' });
      const r = await onboardingApi.verifyOtp({ phoneNumber: '+15550123', code: '123456' });
      return r.status === 'success' && r.routing === 'profile_setup';
    })()));
  }

  // ══ B — origin allowlist matrix ══
  section('B — trusted-origin allowlist matrix');
  {
    t('192.168.x trusted', isTrustedBrowserOrigin('http://192.168.1.5', NO_ORIGINS));
    t('10.x trusted', isTrustedBrowserOrigin('https://10.1.2.3', NO_ORIGINS));
    t('172.16 trusted', isTrustedBrowserOrigin('https://172.16.0.1', NO_ORIGINS));
    t('172.31 trusted', isTrustedBrowserOrigin('https://172.31.255.1', NO_ORIGINS));
    t('172.32 NOT trusted', isTrustedBrowserOrigin('https://172.32.0.1', NO_ORIGINS) === false);
    t('localhost trusted', isTrustedBrowserOrigin('https://localhost:3000', NO_ORIGINS));
    t('127.0.0.1 trusted', isTrustedBrowserOrigin('http://127.0.0.1', NO_ORIGINS));
    t('sub.localhost trusted', isTrustedBrowserOrigin('http://dev.localhost', NO_ORIGINS));
    t('public IP NOT trusted', isTrustedBrowserOrigin('https://8.8.8.8', NO_ORIGINS) === false);
    t('public host NOT trusted', isTrustedBrowserOrigin('https://example.com', NO_ORIGINS) === false);
    t('configured origin trusted', isTrustedBrowserOrigin('https://wpt.example:8443', ['https://wpt.example:8443']));
    t('normalizeOrigin strips path/trailing slash', normalizeOrigin('https://wpt.example:8443/') === 'https://wpt.example:8443');
    t('non-http scheme not an origin', normalizeOrigin('exp://192.168.1.3:8081') === null);
    t('isPrivateLanHostname localhost', isPrivateLanHostname('localhost') === true);
    t('isPrivateLanHostname 192.168.0.1', isPrivateLanHostname('192.168.0.1') === true);
    t('isPrivateLanHostname 172.30.1.1', isPrivateLanHostname('172.30.1.1') === true);
    t('isPrivateLanHostname 8.8.8.8 false', isPrivateLanHostname('8.8.8.8') === false);
    t('buildAllowedBrowserOrigins includes API origin', buildAllowedBrowserOrigins({ EXPO_PUBLIC_API_BASE_URL: 'https://api.wpt.example/' }).includes('https://api.wpt.example'));
  }

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