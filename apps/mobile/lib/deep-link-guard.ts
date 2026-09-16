// lib/deep-link-guard.ts
//
// DEEP-LINK / QR GATE — parses scanned deep links and decides routing.
//
// A scanned QR payload / URL is untrusted attacker-controlled input. It is
// ROUTING CONTEXT ONLY and must never be treated as proof of identity:
//
//   URL ──> phoneNumber parameter ──> NOT authenticated
//   URL ──> phoneNumber parameter ──> NOT marked OTP-verified
//   URL ──> phoneNumber parameter ──> NOT given a session
//   URL ──> phoneNumber parameter ──> NOT sent to Chat List / Profile Setup /
//                                      Device Handoff
//
// On a fresh/unauthenticated state ANY deep link that targets a protected
// route funnels to `legal-acceptance` and STAYS there until the user
// explicitly clicks Continue/Accept. The decision uses ONLY the locally
// resolved SecureStore snapshot (legal acceptance + session). This module
// NEVER writes auth state — legal is never marked accepted here, a session is
// never created, an OTP is never verified.
//
// This is the reconciled implementation: it keeps the local parser + provenance
// behavior (custom schemes like `wptmobile://`, HTTPS limited to the known app
// host, Expo `exp://` marker, bare paths) and adds the tier-based gate helpers
// the Team Alpha app uses (`normalizeRouteKey`, `decideDeepLinkGate`,
// `decideGateForRoute` -> string | null where null = allowed).
//
// Pure + dependency-free so the contract is Node-verifiable without a device.

import { OnboardingSnapshot, RouteTier, ROUTE_TIERS } from './onboarding-guard';

export interface DeepLinkIntent {
  pathname: string;
  params: Record<string, string>;
  hasPhoneNumber: boolean;
}

/** Auth-significant query keys a deep link may carry. A URL param is NEVER
 *  trusted as identity — this list only drives `hasAuthParam` detection used
 *  by the scanner, never the gate decision. */
export const AUTH_PARAM_KEYS = [
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

/** Hosts that may produce HTTPS universal links resolving to app routes. Any
 *  other HTTPS host (including example.com-style public hosts) is NOT an app
 *  deep link — it is at best a browser URL to be provenance-checked, never an
 *  authenticated route. */
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

/** Strip leading/trailing slashes + percent-encoding from a route key. */
export function normalizeRouteKey(raw: string): string {
  let p = (raw ?? '').trim();
  if (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p = p.slice(0, -1);
  try {
    p = decodeURIComponent(p);
  } catch {
    // leave as-is on malformed encoding
  }
  return p;
}

export function parseDeepLink(input: string | null | undefined): DeepLinkIntent | null {
  const s = (input ?? '').trim();
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
      // A deep link targeting the app root carries no route — treat as null.
      if (!pathname) return null;
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
    const rawPathname = qIdx >= 0 ? s.slice(0, qIdx) : s;
    const queryPart = qIdx >= 0 ? s.slice(qIdx + 1) : '';
    let pathname = rawPathname.slice(1) || rawPathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // leave as-is on malformed encoding
    }
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

function routeTierFor(routeKey: string): RouteTier | undefined {
  if (ROUTE_TIERS[routeKey]) return ROUTE_TIERS[routeKey];
  if (routeKey.includes('/')) return ROUTE_TIERS[routeKey.split('/')[0]];
  return undefined;
}

/**
 * Central gate decision for a resolved route key against the SecureStore
 * snapshot. Returns the gate to navigate to, or null when the route is allowed:
 *   - public tier      → allowed (null)
 *   - legal_required   → allowed only when legalAccepted → else /legal-acceptance
 *   - session_required → allowed only when a session exists → else
 *                        /legal-acceptance (no legal) or /phone-entry (legal only)
 * URL params are intentionally NOT inputs — a phone number/userId/token can
 * never grant access to a protected route.
 */
export function decideGateForRoute(routeKey: string, snapshot: OnboardingSnapshot): string | null {
  const tier = routeTierFor(routeKey);
  if (!tier || tier === 'public') return null;
  if (tier === 'legal_required') {
    return snapshot.legalAccepted ? null : '/legal-acceptance';
  }
  if (snapshot.hasSession) return null;
  return snapshot.legalAccepted ? '/phone-entry' : '/legal-acceptance';
}

/**
 * Deep-link variant of the gate. The `phoneNumber` (or any other) URL param is
 * intentionally NOT an input to the decision — a URL param can never grant
 * access to a protected route. The decision depends only on the target route's
 * tier and the locally-resolved SecureStore snapshot.
 */
export function decideDeepLinkGate(intent: DeepLinkIntent, snapshot: OnboardingSnapshot): string | null {
  return decideGateForRoute(intent.pathname, snapshot);
}