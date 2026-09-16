// lib/qr-link.ts
//
// QR SCAN BOUNDARY — a scanned QR payload is ROUTING CONTEXT ONLY. It is
// untrusted attacker-controlled input and must never be treated as proof of
// identity:
//
//   QR ──> phone=9876543210    ──> NOT authenticated
//   QR ──> %2B919876543210     ──> NOT authenticated
//   QR ──> phone in path       ──> NOT authenticated
//   QR ──> app deep link       ──> through the SAME deep-link security gate
//   QR ──> browser URL         ──> opened only for a trusted destination
//
// Two guards apply, in order:
//   1. Provenance: a scanned browser URL is opened ONLY when its origin is an
//      intended destination (configured hosts + localhost/LAN dev machines).
//   2. Gating: when the scanned value resolves to one of the app's own routes
//      (custom scheme like `wptmobile://`, Expo `exp://`, universal-link style
//      https, or a bare path) it goes through `decideGateForRoute` against the
//      SecureStore snapshot — the same decision the root DeepLinkGuard uses.
//      A URL phone number never creates a session, never marks an OTP verified,
//      and never reaches Chat List / Profile Setup / Device Handoff.
//
// Pure + dependency-free so the whole contract is Node-verifiable without a
// device or camera.
import { OnboardingSnapshot } from './onboarding-guard';
import {
  DeepLinkIntent,
  decideGateForRoute,
  hasAppRoute,
  parseDeepLink,
} from './deep-link-guard';

export type ScannedLinkKind = 'app_deep_link' | 'browser_url' | 'unsupported';

type BrowserLink = { kind: 'browser_url'; url: string; origin: string; host: string };

export type ScannedLinkClassification =
  | { kind: 'app_deep_link'; intent: DeepLinkIntent }
  | BrowserLink
  | { kind: 'unsupported'; reason: 'empty' | 'invalid' };

export const AUTH_QUERY_KEYS: readonly string[] = [
  'phoneNumber',
  'userId',
  'deviceId',
  'accessToken',
  'refreshToken',
];

/** http(s) URL detector (the only form the scanner will ever hand to a browser). */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/.+/i.test(value.trim());
}

/**
 * Decide whether a scanned value is an app route (must go through the security
 * gate), a plain browser URL (must be host-vetted before opening), or
 * unsupported garbage. The phone number / any param is NEVER an input here.
 */
export function classifyScannedLink(value: string): ScannedLinkClassification {
  const raw = (value ?? '').trim();
  if (!raw) return { kind: 'unsupported', reason: 'empty' };

  const intent = parseDeepLink(raw);
  if (intent && hasAppRoute(intent.pathname)) {
    return { kind: 'app_deep_link', intent };
  }

  if (isHttpUrl(raw)) {
    let origin = '';
    let host = '';
    try {
      const u = new URL(raw);
      origin = u.origin;
      host = u.hostname.toLowerCase();
    } catch {
      // fallthrough to unsupported
    }
    if (origin && host) {
      return { kind: 'browser_url', url: raw, origin, host };
    }
  }

  return { kind: 'unsupported', reason: 'invalid' };
}

/** Normalize a config value ("https://wpt.example:8443/") to a bare origin. */
export function normalizeOrigin(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Dotted-quad IPv4 loopback / RFC1918 private-LAN hostname detection. */
export function isPrivateLanHostname(hostname: string): boolean {
  const host = (hostname ?? '').toLowerCase().trim();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return false;
  const [a, b] = parts.map(Number);
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Trusted browser destinations for a scanned QR. The origin is allowed when it
 * is an explicitly configured origin OR it lives on the local machine / a
 * private LAN (the WPT demo web + backend run on the developer's LAN). Public
 * internet hosts are NOT intended destinations.
 */
export function isTrustedBrowserOrigin(
  origin: string | null | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) return false;
  const norm = normalizeOrigin(origin);
  if (!norm) return false;
  if (allowedOrigins.includes(norm)) return true;
  let host = '';
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isPrivateLanHostname(host)) return true;
  return false;
}

/**
 * Build the allowed browser-origin list from app env:
 *   - EXPO_PUBLIC_QR_LINK_HOSTS — comma/semicolon separated origins (optional,
 *     for a hosted WPT deployment).
 *   - the configured API/backend origins (hosted WPT deployments are served
 *     from the same origin as the API).
 * LAN/localhost destinations are always acceptable (the demo runs there).
 */
export function buildAllowedBrowserOrigins(
  env: Record<string, string | undefined>,
): string[] {
  const out = new Set<string>();
  const push = (v: string | undefined) => {
    const norm = normalizeOrigin(v);
    if (norm) out.add(norm);
  };
  const csv = env?.EXPO_PUBLIC_QR_LINK_HOSTS ?? '';
  for (const part of csv.split(/[,;]/)) {
    push(part.trim());
  }
  push(env?.EXPO_PUBLIC_API_BASE_URL);
  push(env?.EXPO_PUBLIC_BACKEND_URL);
  return [...out];
}

export type ScannedLinkAction =
  | { action: 'gate_to'; gate: '/legal-acceptance' | '/phone-entry'; intent: DeepLinkIntent }
  | { action: 'open_app_route'; intent: DeepLinkIntent }
  | { action: 'open_browser'; url: string }
  | { action: 'block'; reason: 'unsupported_host' | 'invalid_qr' };

/**
 * The full scanner decision for a scanned value. Identity-bearing parameters
 * are intentionally NOT inputs: a scanned value can never authenticate.
 */
export function decideScannedLinkAction(
  value: string,
  snapshot: OnboardingSnapshot,
  allowedOrigins: readonly string[],
): ScannedLinkAction {
  const cls = classifyScannedLink(value);

  if (cls.kind === 'unsupported') {
    return { action: 'block', reason: 'invalid_qr' };
  }

  if (cls.kind === 'app_deep_link') {
    const gate = decideGateForRoute(cls.intent.pathname, snapshot);
    if (gate === '/legal-acceptance' || gate === '/phone-entry') {
      return { action: 'gate_to', gate, intent: cls.intent };
    }
    return { action: 'open_app_route', intent: cls.intent };
  }

  // Browser URL — provenance check before anything may be opened.
  if (isTrustedBrowserOrigin(cls.origin, allowedOrigins)) {
    return { action: 'open_browser', url: cls.url };
  }
  return { action: 'block', reason: 'unsupported_host' };
}