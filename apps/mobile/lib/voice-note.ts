// lib/voice-note.ts
//
// PERM-2.7 / PERM-2.8 — pure voice-note gating (no native imports, verified
// in Node). Only a GRANTED gate may ever reach the OS recorder.

import type { PermissionState } from './permissions';

export type MicGate = 'granted' | 'denied' | 'undetermined';

export const MIN_VOICE_NOTE_SEC = 1;

export function micGateFrom(state: PermissionState | null): MicGate {
  if (state === 'granted') return 'granted';
  if (state === 'unknown' || state === null) return 'undetermined';
  return 'denied';
}

export function canRecordVoiceNotes(gate: MicGate): boolean {
  return gate === 'granted';
}

/** record = start capture; request = ask the OS first; denied = Settings dialog, no capture. */
export function decideRecordAction(gate: MicGate): 'record' | 'request' | 'denied' {
  if (gate === 'granted') return 'record';
  if (gate === 'undetermined') return 'request';
  return 'denied';
}

export function isUsableVoiceNote(durationSec: number): boolean {
  return Number.isFinite(durationSec) && durationSec >= MIN_VOICE_NOTE_SEC;
}

export function formatVoiceDuration(sec: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  return `${Math.floor(safe / 60)}:${(safe % 60).toString().padStart(2, '0')}`;
}
