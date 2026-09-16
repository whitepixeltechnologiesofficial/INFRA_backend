// lib/route-guard.ts
//
// CENTRALIZED ROUTE GATE — the SINGLE decision point for whether a route may be
// rendered given the durable onboarding snapshot. Used by every protected
// screen (via `hooks/useRouteGuard`) so direct URL / deep-link navigation to a
// protected route is blocked BEFORE the screen renders anything.
//
// Security invariants enforced here:
//   - Query params (phoneNumber, phone, userId, accountId, accessToken, token,
//     session, refreshToken, ...) are NEVER trusted as authentication or
//     identity. They are not even read by this module; only the SecureStore
//     snapshot decides.
//   - Fresh/unauthenticated → /legal-acceptance (params discarded).
//   - Legal accepted but no session → /phone-entry (params discarded).
//   - Only an authenticated session opens protected routes.
//   - `otp-entry` is the sole legal-gated (not session-gated) screen — it is the
//     step that ESTABLISHES the session, and verify can only succeed after a
//     real sendOtp created a session for the number.
//
// Pure + dependency-free so the whole contract is Node-verifiable without a
// device or SecureStore runtime.

import { OnboardingSnapshot } from './onboarding-guard';

export type RouteGateDecision =
  | { action: 'allow' }
  | { action: 'redirect'; to: '/legal-acceptance' | '/phone-entry' };

/** Routes that are intentionally public entry points of the onboarding flow. */
const PUBLIC_ROUTES = new Set(['', 'index', 'legal-acceptance', 'phone-entry']);

/** The only protected screen reachable with legal acceptance but no session. */
const LEGAL_GATED_ROUTES = new Set(['otp-entry']);

/**
 * Decide the gate for an in-app route. `route` is the expo-router screen id as
 * passed by the calling screen (`profile-setup`, `(tabs)`, `otp-entry`, ...).
 * Leading/trailing slashes are normalized away.
 */
export function resolveRouteGate(
  route: string,
  snapshot: OnboardingSnapshot,
): RouteGateDecision {
  const id = (route ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (id === '' || PUBLIC_ROUTES.has(id)) {
    return { action: 'allow' };
  }

  if (LEGAL_GATED_ROUTES.has(id)) {
    return snapshot.legalAccepted
      ? { action: 'allow' }
      : { action: 'redirect', to: '/legal-acceptance' };
  }

  // Everything else reachable in the app is authenticated-only.
  if (!snapshot.legalAccepted) {
    return { action: 'redirect', to: '/legal-acceptance' };
  }
  if (!snapshot.hasSession) {
    return { action: 'redirect', to: '/phone-entry' };
  }
  return { action: 'allow' };
}