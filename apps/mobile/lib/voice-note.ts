export type MicGate = 'granted' | 'denied' | 'undetermined';

export type VoiceNoteDraft = {
  audioUri: string;
  durationSec: number;
  id: string;
  sentAt: Date;
  time: string;
};

const MIN_VOICE_NOTE_SECONDS = 1;

export function classifyMicGranted(granted: boolean, status: string): MicGate {
  if (granted) return 'granted';
  if (status === 'denied' || status === 'blocked' || status === 'limited') return 'denied';
  return 'undetermined';
}

export function canRecordVoiceNotes(gate: MicGate): boolean {
  return gate === 'granted';
}

export type MicRecordAction = 'record' | 'request' | 'denied';

/**
 * Decides what the voice-note entry point should do for the given mic gate.
 * - `record`  -> show recording UI and start the OS recorder (granted only).
 * - `request` -> the user hasn't decided yet (undetermined): ask first.
 * - `denied`  -> never record; direct the user to device Settings (PERM-2.7).
 *
 * `record` is the ONLY action that may touch the OS recorder, which is what
 * guarantees a denied user can never capture audio (even before the OS-level
 * permission check resolves).
 */
export function decideRecordAction(gate: MicGate): MicRecordAction {
  if (canRecordVoiceNotes(gate)) return 'record';
  if (gate === 'denied') return 'denied';
  return 'request';
}

export function isUsableVoiceNote(durationSec: number): boolean {
  return typeof durationSec === 'number' && durationSec >= MIN_VOICE_NOTE_SECONDS;
}

export function formatVoiceDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function buildVoiceNoteDraft(audioUri: string, durationSec: number, now: Date = new Date()): VoiceNoteDraft {
  if (!audioUri) throw new Error('VOICE_NOTE_NO_URI');
  const dur = Math.floor(durationSec);
  if (!isUsableVoiceNote(dur)) throw new Error('VOICE_NOTE_TOO_SHORT');
  return {
    audioUri,
    durationSec: dur,
    id: `vn${now.getTime()}`,
    sentAt: now,
    time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
}