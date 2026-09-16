// lib/deep-link-guard.ts
//
// DEEP-LINK / QR GATE — parses scanned deep links and decides routing.
//
// A scanned QR payload is untrusted attacker-controlled input. It is ROUTING
// CONTEXT ONLY and must never be treated as proof of identity. A phone number
// in a QR URL never creates a session, never marks an OTP verified, and never
// reaches Chat List / Profile Setup / Device Handoff.
//
// Two layers of security:
//   1. Provenance (in qr-link.ts): browser URLs open only for trusted hosts.
//   2. Gating (here): app routes go through decideGateForRoute — the same
//      decision the root DeepLinkGuard uses.
//
// Pure + dependency-free (Node-verifiable).

import { OnboardingSnapshot } from './onboarding-guard';

export interface DeepLinkIntent {
  pathname: string;
  params: Record<string, string>;
  hasPhoneNumber: boolean;
}

const AUTH_PARAM_KEYS = [
  'phoneNumber',
  'phone',
  'userId',
  'deviceId',
  'accessToken',
  'refreshToken',
  'account',
  'id',
  'token',
];

const AUTH_PATHNAMES = new Set(['device-handoff']);

const PUBLIC_ROUTES = new Set([
  'legal-acceptance',
  'phone-entry',
  'otp-entry',
]);

// Hosts that may produce HTTPS universal links resolving to app routes. Any
// other HTTPS host (including example.com-style public hosts) is NOT an app
// deep link — it is at best a browser URL to be provenance-checked, never an
// authenticated route.
const KNOWN_APP_HOSTS = ['onb.test'];

function isKnownAppHost(host: string): boolean {
  const h = (host ?? '').toLowerCase();
  return KNOWN_APP_HOSTS.some((k) => h === k || h.endsWith('.' + k));
}

const APP_ROUTES = new Set([
  '(tabs)',
  'settings',
  'profile-setup',
  'permission-intro',
  'permission-info',
  'notifications-info',
  'device-handoff',
  'phone-entry',
  'otp-entry',
  'legal-acceptance',
  'index',
  'scan',
  'explore',
  'camera',
  'gallery',
  'voice-note',
]);

export function parseDeepLink(raw: string): DeepLinkIntent | null {
  const s = (raw ?? '').trim();
  if (!s) return null;

  // HTTPS universal link — must be handled BEFORE custom-scheme check since
  // "https://" matches the scheme regex. Only known app hosts may resolve to
  // an app route; any other HTTPS URL is not a deep link (provenance applies).
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (!isKnownAppHost(u.hostname)) return null;
      const params: Record<string, string> = {};
      let hasPhoneNumber = false;
      u.searchParams.forEach((v, k) => {
        params[k] = v;
        if (AUTH_PARAM_KEYS.includes(k)) hasPhoneNumber = true;
      });
      const pathname = decodeURIComponent(u.pathname || '/').replace(/^\/+/, '') || '/';
      return { pathname, params, hasPhoneNumber };
    } catch {
      return null;
    }
  }

  // exp://192.168.1.3:8081/--/route-name
  if (/^exp:\/\//i.test(s)) {
    try {
      const sep = s.indexOf('/--/');
      if (sep === -1) return null;
      const rest = s.slice(sep + 4);
      const qIdx = rest.indexOf('?');
      const pathPart = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
      const queryPart = qIdx >= 0 ? rest.slice(qIdx + 1) : '';
      const pathname = decodeURIComponent(pathPart);
      const params: Record<string, string> = {};
      let hasPhoneNumber = false;
      for (const pair of queryPart.split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        const k = decodeURIComponent(eq >= 0 ? pair.slice(0, eq) : pair);
        const v = decodeURIComponent(eq >= 0 ? pair.slice(eq + 1) : '');
        params[k] = v;
        if (AUTH_PARAM_KEYS.includes(k)) hasPhoneNumber = true;
      }
      return { pathname, params, hasPhoneNumber };
    } catch {
      return null;
    }
  }

  // Custom scheme: wptmobile://, sms://, etc.
  const schemeMatch = s.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):\/\//);
  if (schemeMatch) {
    const afterScheme = s.slice(schemeMatch[0].length);
    const qIdx = afterScheme.indexOf('?');
    const pathPart = qIdx >= 0 ? afterScheme.slice(0, qIdx) : afterScheme;
    const queryPart = qIdx >= 0 ? afterScheme.slice(qIdx + 1) : '';
    const hostOrPath = decodeURIComponent(pathPart);
    if (!hostOrPath) return null;
    const params: Record<string, string> = {};
    let hasPhoneNumber = false;
    for (const pair of queryPart.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = decodeURIComponent(eq >= 0 ? pair.slice(0, eq) : pair);
      const v = decodeURIComponent(eq >= 0 ? pair.slice(eq + 1) : '');
      params[k] = v;
      if (AUTH_PARAM_KEYS.includes(k)) hasPhoneNumber = true;
    }
    return { pathname: hostOrPath, params, hasPhoneNumber };
  }

  // Bare path: /route-name?params
  if (s.startsWith('/')) {
    const qIdx = s.indexOf('?');
    const pathname = qIdx >= 0 ? s.slice(0, qIdx) : s;
    const queryPart = qIdx >= 0 ? s.slice(qIdx + 1) : '';
    const params: Record<string, string> = {};
    let hasPhoneNumber = false;
    for (const pair of queryPart.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = decodeURIComponent(eq >= 0 ? pair.slice(0, eq) : pair);
      const v = decodeURIComponent(eq >= 0 ? pair.slice(eq + 1) : '');
      params[k] = v;
      if (AUTH_PARAM_KEYS.includes(k)) hasPhoneNumber = true;
    }
    return { pathname: pathname.slice(1) || pathname, params, hasPhoneNumber };
  }

  return null;
}

export function hasAppRoute(pathname: string): boolean {
  return APP_ROUTES.has(pathname);
}

export function hasAuthParam(intent: DeepLinkIntent | null): boolean {
  if (!intent) return false;
  return intent.hasPhoneNumber;
}

/**
 * Gate a resolved app route against the SecureStore snapshot.
 *
 * Public routes (legal-acceptance, phone-entry, otp-entry) always resolve
 * freely — they are entry points and don't require an existing session.
 * Protected routes require a session; device-handoff always requires a
 * fresh OTP login (never silently opened from a QR scan).
 *
 * Fresh:  -> /legal-acceptance   (must accept terms first)
 * Legal:  -> /phone-entry        (must verify phone first)
 * Session -> open (or -> /phone-entry for device-handoff)
 */
export function decideGateForRoute(
  pathname: string,
  snapshot: OnboardingSnapshot,
): string {
  if (pathname === '/' || pathname === 'legal-acceptance' || pathname === 'index') {
    return '/legal-acceptance';
  }

  if (!snapshot.legalAccepted) {
    return '/legal-acceptance';
  }

  if (!snapshot.userId) {
    if (pathname === 'otp-entry' || pathname === 'phone-entry') {
      return pathname;
    }
    return '/phone-entry';
  }

  if (AUTH_PATHNAMES.has(pathname)) {
    return '/phone-entry';
  }

  return pathname;
}
