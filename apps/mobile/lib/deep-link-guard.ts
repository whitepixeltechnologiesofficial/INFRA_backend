// lib/deep-link-guard.ts
//
// URL AUTH BYPASS GUARD — a phone number supplied through a URL (Expo Go deep
// link, universal link, web URL) is ROUTING CONTEXT ONLY. It must never be
// treated as proof of identity:
//
//   URL ──> phoneNumber parameter ──> NOT authenticated
//   URL ──> phoneNumber parameter ──> NOT marked OTP-verified
//   URL ──> phoneNumber parameter ──> NOT given a session
//   URL ──> phoneNumber parameter ──> NOT sent to Chat List / Profile Setup
//
// On a fresh/unauthenticated state ANY deep link that targets a protected
// route funnels to `legal-acceptance` and STAYS there until the user
// explicitly clicks Continue/Accept on the Legal Acceptance screen. Directing
// to the legal gate is the ONLY thing this module does — it never marks legal
// as accepted, never creates a session, and never marks an OTP verified. The
// root layout feeds both the launch URL and the resolved pathname through the
// `decide*` helpers so the security boundary lives at the navigation root
// (resolve-before-render), not scattered across screens.
//
// Pure + dependency-free so the contract is Node-verifiable without a device.
import { OnboardingSnapshot, RouteTier, ROUTE_TIERS } from './onboarding-guard';

export interface DeepLinkIntent {
  pathname: string;
  params: Record<string, string>;
  hasPhoneNumber: boolean;
}

export const AUTH_PARAM_KEYS = Object.freeze(['phoneNumber', 'userId', 'deviceId']);

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

/**
 * Parse a deep-link URL into a route intent. Handles:
 *   - Expo Go URLs: exp://host:port/--/{path}?{query}
 *   - universal links: https://.../{path}?{query}
 *   - bare paths: /{path}?{query}
 * Returns null when the link carries no app route (bare root/app-open).
 */
export function parseDeepLink(input: string | null | undefined): DeepLinkIntent | null {
  const href = (input ?? '').trim();
  if (!href) return null;

  let pathAndQuery = href;

  const MARKER = '/--/';
  const markerAt = href.indexOf(MARKER);
  if (markerAt !== -1) {
    pathAndQuery = href.slice(markerAt + MARKER.length);
  } else if (!href.startsWith('/')) {
    try {
      const u = new URL(href);
      if (!u.pathname || u.pathname === '/') return null;
      pathAndQuery = u.pathname + u.search;
    } catch {
      return null;
    }
  }

  const qAt = pathAndQuery.indexOf('?');
  const rawPath = qAt === -1 ? pathAndQuery : pathAndQuery.slice(0, qAt);
  const rawQuery = qAt === -1 ? '' : pathAndQuery.slice(qAt + 1);

  const pathname = normalizeRouteKey(rawPath);
  if (!pathname) return null;

  const params: Record<string, string> = {};
  for (const pair of rawQuery.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    if (!rawKey) continue;
    let key = rawKey;
    let value = rawVal;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      // keep raw key on malformed encoding
    }
    try {
      value = decodeURIComponent(rawVal);
    } catch {
      // keep raw value on malformed encoding
    }
    params[key] = value;
  }

  return { pathname, params, hasPhoneNumber: hasOwn(params, 'phoneNumber') };
}

/** Whether any auth-significant key is present in the URL params. */
export function hasAuthParam(intent: DeepLinkIntent | null): boolean {
  if (!intent) return false;
  return AUTH_PARAM_KEYS.some((key) => hasOwn(intent.params, key));
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function routeTierFor(routeKey: string): RouteTier | undefined {
  if (ROUTE_TIERS[routeKey]) return ROUTE_TIERS[routeKey];
  if (routeKey.includes('/')) return ROUTE_TIERS[routeKey.split('/')[0]];
  return undefined;
}

/**
 * Central gate decision for a resolved route key against the SecureStore
 * snapshot. Returns the gate to navigate to, or null when the route is
 * allowed:
 *   - public tier      → allowed (null)
 *   - legal_required   → allowed only when legalAccepted → else /legal-acceptance
 *   - session_required → allowed only when a session exists → else
 *                        /legal-acceptance (no legal) or /phone-entry (legal only)
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