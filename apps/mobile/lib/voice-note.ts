import * as Audio from 'expo-audio';

export type MicGate = 'granted' | 'denied' | 'undetermined';

export function classifyMicGranted(granted: boolean, status: string): MicGate {
  if (granted) return 'granted';
  if (status === 'denied' || status === 'restricted') return 'denied';
  return 'undetermined';
}

export function canRecordVoiceNotes(gate: MicGate): boolean {
  return gate === 'granted';
}

export function formatVoiceDuration(sec: number): string {
  const mins = Math.floor(sec / 60);
  const remaining = Math.floor(sec % 60);
  return `${mins}:${remaining.toString().padStart(2, '0')}`;
}

export function decideRecordAction(gate: MicGate): 'record' | 'request' | 'denied' {
  if (gate === 'granted') return 'record';
  if (gate === 'undetermined') return 'request';
  return 'denied';
}
