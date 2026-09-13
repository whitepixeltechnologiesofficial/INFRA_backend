// lib/session-policy.ts
//
// ONB-1.7 — pure, dependency-free session-policy decisions. Node-verifiable so
// the client-side mechanisms (post-login routing, silent cutoff decision, and
// the singleton polling lifecycle) can be asserted in a headless harness
// WITHOUT a device, while still being the exact code the app runs.

export type PostLoginRoute = 'device-handoff' | 'chats' | 'profile_setup';

/** The shape `verifyOtp`/`handleLoginHandoff` report back after a login. */
export interface PostLoginResult {
  routing: 'chats' | 'profile_setup';
  previousDevicesLoggedOut: number;
}

/**
 * Where a successful login should continue (PRD 5.1–5.4 / ONB-1.7):
 *   - New user completing setup → profile-setup (the normal onboarding path).
 *   - Existing user whose login revoked other devices → device-handoff (the
 *     new-device confirmation shown ONLY here).
 *   - Existing user with no other active devices → straight into the app.
 */
export function resolvePostLoginRoute(result: PostLoginResult): PostLoginRoute {
  if (result.routing === 'profile_setup') return 'profile_setup';
  if (result.previousDevicesLoggedOut > 0) return 'device-handoff';
  return 'chats';
}

export type CutoffDecision = 'keep' | 'cutoff';

/**
 * Silent-cutoff decision (one-half of the ONB-1.7 rule): the backend is the
 * source of truth. When it reports the session invalid/revoked, the local
 * session is cut off with NO warning UI. When it says valid (or is
 * unreachable), the user is left alone.
 */
export function decideSessionCutoff(isValid: boolean): CutoffDecision {
  return isValid ? 'keep' : 'cutoff';
}

/**
 * Singleton, background-aware polling lifecycle for session verification.
 * Guarantees:
 *   - at most one interval exists (start() is idempotent),
 *   - stop() tears it down (no timers leak),
 *   - deactivating STOPS the interval (no requests while backgrounded) and
 *     reactivating RESTARTS it (idempotent — no duplicate timers).
 */
export class SessionPoller {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onTick: () => void, private readonly intervalMs: number) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.onTick();
    }, this.intervalMs);
  }

  /** Pause (background) or resume (foreground) the polling loop. */
  setActive(isActive: boolean): void {
    if (isActive) {
      this.start();
    } else {
      this.stop();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}