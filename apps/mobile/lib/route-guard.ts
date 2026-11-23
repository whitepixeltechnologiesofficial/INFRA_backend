import { OnboardingSnapshot } from './onboarding-guard';

export type RouteGateDecision =
  | { action: 'allow' }
  | { action: 'redirect'; to: '/legal-acceptance' | '/phone-entry' };

const PUBLIC_ROUTES = new Set(['', 'index', 'legal-acceptance', 'phone-entry']);
const LEGAL_GATED_ROUTES = new Set(['otp-entry']);

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

  if (!snapshot.legalAccepted) {
    return { action: 'redirect', to: '/legal-acceptance' };
  }
  if (!snapshot.hasSession) {
    return { action: 'redirect', to: '/phone-entry' };
  }
  return { action: 'allow' };
}
