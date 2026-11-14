// lib/permission-sequence.ts
//
// PERM-2.2 — the five native OS permission dialogs, fired one after another
// in a FIXED order (PRD §5.3): Contacts -> Notifications -> Microphone ->
// Camera -> Photos/Files. Same order on every platform.
//
// Pure and dependency-injected (no React Native imports) so the contract is
// verifiable in Node: scripts/perm-2-verify.ts drives it with fake dialogs.
//
// Rules this module enforces:
//  - Each requester is a SINGLE-permission call. The next one is not invoked
//    until the previous promise settles (grant, deny, or an OEM skin that
//    answers without showing a dialog). Never parallel, never a batch API.
//  - A denial never stops the sequence; every step always runs.
//  - Progress is persisted after every answered step. If the app is killed or
//    interrupted mid-sequence, the next run resumes at the first unanswered
//    step instead of restarting from Contacts.
//  - run() is idempotent while in flight: a second caller (e.g. the AppState
//    foreground listener) joins the running sequence instead of starting a
//    parallel one.

export const PERMISSION_ORDER = ['contacts', 'notifications', 'microphone', 'camera', 'photos'] as const;

export type PermissionKey = (typeof PERMISSION_ORDER)[number];

/** `unavailable` = the platform could not ask at all (e.g. module missing). */
export type StepOutcome = 'granted' | 'denied' | 'unavailable';

/**
 * explainer: profile setup finished, the explainer has not been confirmed yet.
 * running:   Continue was pressed; dialogs are being (or were being) asked.
 * done:      all five answered.
 */
export type SequenceStage = 'explainer' | 'running' | 'done';

export interface SequenceProgress {
  stage: SequenceStage;
  next: number;
  results: Partial<Record<PermissionKey, StepOutcome>>;
}

export interface ProgressStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}

export type Requesters = Record<PermissionKey, () => Promise<StepOutcome>>;

export const SEQUENCE_STORE_KEY = 'onb.permissionSequence';

export function initialProgress(): SequenceProgress {
  return { stage: 'explainer', next: 0, results: {} };
}

export function parseProgress(raw: string | null): SequenceProgress | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<SequenceProgress>;
    if (p.stage !== 'explainer' && p.stage !== 'running' && p.stage !== 'done') return null;
    if (typeof p.next !== 'number' || !Number.isInteger(p.next)) return null;
    const next = Math.max(0, Math.min(PERMISSION_ORDER.length, p.next));
    const results: SequenceProgress['results'] = {};
    for (const key of PERMISSION_ORDER) {
      const v = p.results?.[key];
      if (v === 'granted' || v === 'denied' || v === 'unavailable') results[key] = v;
    }
    return { stage: next >= PERMISSION_ORDER.length ? 'done' : p.stage, next, results };
  } catch {
    return null;
  }
}

/** True while the user still owes the explainer or the OS sequence. */
export function isSequencePending(p: SequenceProgress | null): boolean {
  return p !== null && p.stage !== 'done';
}

export interface PermissionSequence {
  /** Mark the explainer as owed (called when profile setup completes). */
  arm(): Promise<void>;
  /** Read persisted progress (null = this account never entered the flow). */
  load(): Promise<SequenceProgress | null>;
  /** Start, or resume, the sequence. Resolves when all five are answered. */
  run(): Promise<SequenceProgress>;
  isRunning(): boolean;
}

export function createPermissionSequence(opts: {
  requesters: Requesters;
  store: ProgressStore;
  onStep?: (key: PermissionKey, outcome: StepOutcome) => void;
}): PermissionSequence {
  const { requesters, store, onStep } = opts;
  let inFlight: Promise<SequenceProgress> | null = null;

  const save = (p: SequenceProgress) => store.set(JSON.stringify(p));

  async function drive(): Promise<SequenceProgress> {
    let p = parseProgress(await store.get()) ?? initialProgress();
    if (p.stage === 'done') return p;
    if (p.stage === 'explainer') {
      p = { ...p, stage: 'running' };
      await save(p);
    }
    while (p.next < PERMISSION_ORDER.length) {
      const key = PERMISSION_ORDER[p.next];
      let outcome: StepOutcome;
      try {
        outcome = await requesters[key]();
      } catch {
        outcome = 'unavailable';
      }
      const next = p.next + 1;
      p = {
        stage: next >= PERMISSION_ORDER.length ? 'done' : 'running',
        next,
        results: { ...p.results, [key]: outcome },
      };
      await save(p);
      try {
        onStep?.(key, outcome);
      } catch {
        // a side effect (sync, push registration) must never break the sequence
      }
    }
    return p;
  }

  return {
    async arm() {
      const current = parseProgress(await store.get());
      if (current && current.stage !== 'explainer') return;
      await save(initialProgress());
    },
    load: async () => parseProgress(await store.get()),
    run() {
      if (!inFlight) {
        inFlight = drive().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    isRunning: () => inFlight !== null,
  };
}
