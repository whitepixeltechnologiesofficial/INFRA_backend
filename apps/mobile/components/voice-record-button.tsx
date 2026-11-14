// components/voice-record-button.tsx
//
// PERM-2.7 — press-and-hold voice-note recording.
//
// This component is rendered ONLY when the Microphone gate is `granted`
// (see ChatView). It is the only place that creates an expo-audio recorder,
// so while Microphone is denied or undetermined no recorder object exists at
// all and nothing can capture audio behind the permission check (PERM-2.8).

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { formatVoiceDuration, isUsableVoiceNote } from '@/lib/voice-note';
import type { ThemeColors } from '@/lib/theme';

interface Props {
  colors: ThemeColors;
  onRecorded: (uri: string, durationSec: number) => void;
  onError: (message: string) => void;
  onRecordingChange?: (recording: boolean) => void;
}

export function VoiceRecordButton({ colors, onRecorded, onError, onRecordingChange }: Props) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);
  const holding = useRef(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      if (startedAt.current) setElapsed((Date.now() - startedAt.current) / 1000);
    }, 250);
    return () => clearInterval(t);
  }, [recording]);

  useEffect(() => onRecordingChange?.(recording), [recording, onRecordingChange]);

  const stop = async (send: boolean) => {
    if (!startedAt.current) return;
    const duration = (Date.now() - startedAt.current) / 1000;
    startedAt.current = null;
    setRecording(false);
    setElapsed(0);
    try {
      await recorder.stop();
    } catch {
      onError('Recording failed.');
      return;
    }
    if (!send) return;
    const uri = recorder.uri;
    if (!uri) {
      onError('Recording failed.');
    } else if (!isUsableVoiceNote(duration)) {
      onError('Hold the mic button to record a voice note.');
    } else {
      onRecorded(uri, duration);
    }
  };

  const onPressIn = async () => {
    holding.current = true;
    if (busy.current || startedAt.current) return;
    busy.current = true;
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (!holding.current) return;
      recorder.record();
      startedAt.current = Date.now();
      setRecording(true);
    } catch {
      onError('Could not start recording.');
    } finally {
      busy.current = false;
    }
  };

  const onPressOut = () => {
    holding.current = false;
    void stop(true);
  };

  return (
    <View style={s.wrap}>
      {recording && (
        <View style={[s.timer, { backgroundColor: colors.bg2 }]}>
          <View style={s.dot} />
          <Text style={[s.timerText, { color: colors.text }]}>{formatVoiceDuration(elapsed)}</Text>
        </View>
      )}
      <Pressable
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        accessibilityRole="button"
        accessibilityLabel="Hold to record a voice note"
        style={[s.button, { backgroundColor: recording ? colors.danger : colors.accentDim }]}
      >
        <Ionicons name="mic" size={20} color={recording ? '#FFF' : colors.accent} />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center' },
  button: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  timer: {
    position: 'absolute',
    right: 50,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444', marginRight: 6 },
  timerText: { fontSize: 13, fontFamily: 'Lato-Bold' },
});
