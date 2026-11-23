// lib/permission-state.ts
//
// Pure, dependency-free three-state permission model (Node-verifiable).
//
//   NOT_DETERMINED ('undetermined') -> ask the OS (native dialog is allowed).
//   DENIED / BLOCKED / RESTRICTED    -> app guidance + Settings redirect.
//   GRANTED / LIMITED                -> enable the feature immediately.
//
// The cardinal rule these helpers encode: the Settings-only redirect is NEVER
// the answer to a first-time request while the OS can still be asked. Settings
// is reachable only from the 'settings' outcome of an actual ask.

export type FeatureGate = 'granted' | 'denied' | 'undetermined';

/**
 * Map a permission-query result (e.g. check*State()) to the three-state gate.
 * 'unavailable' means the OS will not grant it here, so it behaves like a
 * denial (the app cannot ask again).
 */
export function classifyFeatureGate(state: 'unknown' | 'granted' | 'denied' | 'unavailable'): FeatureGate {
  if (state === 'granted') return 'granted';
  if (state === 'denied' || state === 'unavailable') return 'denied';
  return 'undetermined';
}

export type AttachAction = 'open' | 'ask' | 'settings';

/**
 * Decide what a feature entry point (camera, gallery, ...) must do:
 * - 'open'     -> gate already granted (or a live ask reported granted): open
 *                 the feature immediately, no redundant OS round-trip.
 * - 'ask'      -> gate is undetermined: the OS has never been asked, so issue
 *                 the native request FIRST. This branch can never produce the
 *                 Settings redirect.
 * - 'settings' -> an ask was performed and the OS still denied: show app
 *                 guidance + a Settings redirect.
 *
 * `askResult` reflects the live outcome of `request*Permission()`. With it,
 * the answer is 'open' exactly when the OS reports the feature usable.
 */
export function decideAttachAction(
  gate: FeatureGate,
  askResult?: { granted: boolean },
): AttachAction {
  if (gate === 'granted') return 'open';
  if (askResult) return askResult.granted ? 'open' : 'settings';
  return 'ask';
}

export function canOpenFeature(gate: FeatureGate): boolean {
  return gate === 'granted';
}