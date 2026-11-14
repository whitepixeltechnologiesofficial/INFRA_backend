// app/permission-info.tsx
//
// PERM-2.1 — one-time permissions explainer (PRD Scenario 3.1, §5.3).
// Shown once, right after Profile Setup (ONB-1.5). It is a ONE-WAY explainer:
// a static list of the five permissions with an honest reason each, and a
// single Continue that hands off to the five native OS dialogs (PERM-2.2).
//
//  - No toggles, checkboxes or per-permission buttons: the only grant/deny
//    decision happens in the OS dialogs that follow.
//  - No skip and no other way forward: Continue is the only exit, hardware
//    back and the swipe gesture are disabled, and the Chat List redirects
//    here while the sequence is owed.
//  - Reachable only after Profile Setup armed it; any other arrival is sent
//    away.
//  - If the sequence is interrupted (incoming call, app killed), coming back
//    resumes at the first unanswered dialog, never at Contacts again.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  BackHandler,
  AppState,
  Alert,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { darkColors as COLORS } from '@/lib/theme';
import { permissionSequence, sideEffects } from '@/lib/permission-flow';
import { syncContactsFromDevice } from '@/lib/contact-sync';
import { EXPLAINER_ITEMS } from '@/lib/permission-explainer';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

type Phase = 'checking' | 'explainer' | 'running';

export default function PermissionInfoScreen() {
  const [phase, setPhase] = useState<Phase>('checking');
  const finishing = useRef(false);

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
      return () => sub.remove();
    }, []),
  );

  const finish = useCallback(async () => {
    if (finishing.current) return;
    finishing.current = true;
    const sync = sideEffects.contactSync ? await sideEffects.contactSync : null;
    if (sync?.status === 'failed') {
      Alert.alert(
        "Contacts didn't sync",
        "We couldn't match your contacts just now. You can still start chats by number, and we'll try again.",
        [
          { text: 'Retry now', onPress: () => void syncContactsFromDevice() },
          { text: 'OK' },
        ],
      );
    }
    router.replace('/(tabs)');
  }, []);

  const run = useCallback(async () => {
    setPhase('running');
    const result = await permissionSequence.run();
    if (result.stage === 'done') await finish();
  }, [finish]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const progress = await permissionSequence.load();
      if (cancelled) return;
      if (!progress) {
        router.replace('/');
        return;
      }
      if (progress.stage === 'done') {
        router.replace('/(tabs)');
        return;
      }
      if (progress.stage === 'running') {
        void run();
        return;
      }
      setPhase('explainer');
    })();
    return () => {
      cancelled = true;
    };
  }, [run]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', async (s) => {
      if (s !== 'active' || permissionSequence.isRunning()) return;
      const progress = await permissionSequence.load();
      if (progress?.stage === 'running') void run();
    });
    return () => sub.remove();
  }, [run]);

  if (phase === 'checking') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.accent} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} bounces={false}>
        <Text style={styles.title}>Before you start</Text>
        <Text style={styles.description}>
          Your phone will ask about five permissions next. Here is why we ask for each one.
        </Text>

        <View style={styles.list} accessibilityRole="list">
          {EXPLAINER_ITEMS.map((item) => (
            <View key={item.key} style={styles.row} accessible accessibilityLabel={`${item.title}. ${item.reason}`}>
              <View style={styles.rowIcon}>
                <Ionicons name={item.icon as IconName} size={22} color={COLORS.accent} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{item.title}</Text>
                <Text style={styles.rowReason}>{item.reason}</Text>
              </View>
            </View>
          ))}
        </View>

        <Text style={styles.note}>
          You decide in each system prompt. Saying no to any of them never stops you from messaging, and you can
          change your mind later in Settings.
        </Text>
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.primaryButton, phase === 'running' && styles.primaryButtonBusy]}
          onPress={run}
          disabled={phase === 'running'}
          accessibilityRole="button"
          accessibilityLabel="Continue"
        >
          {phase === 'running' ? (
            <ActivityIndicator color={COLORS.bg} />
          ) : (
            <Text style={styles.primaryButtonText}>Continue</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { paddingHorizontal: 24, paddingTop: 32, paddingBottom: 24 },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 12,
    fontFamily: 'Lato-Bold',
  },
  description: {
    fontSize: 16,
    color: COLORS.textDim,
    lineHeight: 24,
    marginBottom: 28,
    fontFamily: 'Lato-Regular',
  },
  list: { gap: 20, marginBottom: 28 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  rowIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.accentDim,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 16, color: COLORS.text, fontFamily: 'Lato-Bold', marginBottom: 2 },
  rowReason: { fontSize: 14, color: COLORS.textDim, lineHeight: 20, fontFamily: 'Lato-Regular' },
  note: { fontSize: 13, color: COLORS.textDim, lineHeight: 19, fontFamily: 'Lato-Regular' },
  footer: { paddingHorizontal: 24, paddingBottom: 24, paddingTop: 8 },
  primaryButton: {
    backgroundColor: COLORS.accent,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryButtonBusy: { opacity: 0.7 },
  primaryButtonText: {
    color: COLORS.bg,
    fontSize: 16,
    fontWeight: '600',
    fontFamily: 'Lato-Bold',
  },
});
