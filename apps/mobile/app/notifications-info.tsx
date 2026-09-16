// app/notifications-info.tsx
//
// NOTIFICATIONS PERMISSION — Shown after the Contacts screen, before entering
// the Chat List. Explains why notification access is useful, then triggers the
// native Notifications permission dialog. Only Notifications is requested
// here — Contacts was requested on the previous screen, and Microphone /
// Camera / Photos are each requested contextually later.
//
// On grant: push registration happens automatically and the user proceeds.
// On deny: the user proceeds to the Chat List — core messaging is never
// blocked.
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { requestNotificationsPermission, checkNotificationsState } from '@/lib/permissions';
import { useRouteGuard } from '@/hooks/useRouteGuard';

const COLORS = {
  bg: '#0B0F14',
  bg2: '#15171C',
  border: '#2E323C',
  text: '#F3F3F4',
  textDim: '#9AA0AC',
  accent: '#3FC6B8',
  accentDim: 'rgba(63,198,184,0.12)',
};

export default function NotificationsInfoScreen() {
  const { phoneNumber, displayPhone } = useLocalSearchParams<{
    phoneNumber?: string;
    displayPhone?: string;
  }>();
  const [isRequesting, setIsRequesting] = useState(false);

  // ROUTE-GATE — authenticated-only screen (post-profile-setup).
  const snapshot = useRouteGuard('notifications-info');

  const handleContinue = useCallback(async () => {
    if (isRequesting) return;
    setIsRequesting(true);

    try {
      // If the permission was already granted (e.g. re-entering this screen,
      // or a prior session), do not prompt the native dialog again (PERM-STATE).
      const state = await checkNotificationsState();
      if (state === 'unknown') {
        await requestNotificationsPermission();
      }
    } catch {
      // Notifications permission failure is non-fatal — proceed regardless.
    } finally {
      router.replace({
        pathname: '/(tabs)',
        params: { phoneNumber, displayPhone },
      });
    }
  }, [isRequesting, phoneNumber, displayPhone]);

  if (!snapshot) return null;

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.content}>
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <Ionicons
              name="notifications-outline"
              size={30}
              color={COLORS.accent}
            />
          </View>

          <Text style={styles.title}>Stay in the loop</Text>

          <Text style={styles.subtitle}>
            Allow notifications to stay updated about new messages and calls.
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.cardItem}>
            <View style={styles.cardIconContainer}>
              <Ionicons name="chatbubble-outline" size={20} color={COLORS.accent} />
            </View>
            <View style={styles.cardText}>
              <Text style={styles.cardTitle}>New messages</Text>
              <Text style={styles.cardDesc}>
                Get notified when someone sends you a message or tries to call.
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.notice}>
          <Ionicons
            name="information-circle-outline"
            size={18}
            color={COLORS.textDim}
          />
          <Text style={styles.noticeText}>
            You can skip this and enable Notifications later in Settings.
            Your chats will still work without them.
          </Text>
        </View>

        <View style={styles.spacer} />

        <Pressable
          style={[
            styles.continueButton,
            isRequesting && styles.continueButtonDisabled,
          ]}
          onPress={handleContinue}
          disabled={isRequesting}
          accessibilityRole="button"
          accessibilityLabel="Allow notification access"
        >
          {isRequesting ? (
            <ActivityIndicator color={COLORS.bg} size="small" />
          ) : (
            <>
              <Text style={styles.continueText}>ALLOW NOTIFICATIONS</Text>
              <Ionicons name="arrow-forward" size={18} color={COLORS.bg} />
            </>
          )}
        </Pressable>

        <Pressable
          style={styles.skipButton}
          onPress={handleContinue}
          disabled={isRequesting}
          accessibilityRole="button"
          accessibilityLabel="Skip for now"
        >
          <Text style={styles.skipText}>Skip for now</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  content: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 32,
    paddingBottom: 40,
  },
  header: { marginBottom: 28 },
  headerIcon: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: COLORS.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  title: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: '700',
    fontFamily: 'Lora-Bold',
    marginBottom: 10,
  },
  subtitle: {
    color: COLORS.textDim,
    fontSize: 15,
    lineHeight: 23,
    fontFamily: 'Inter-Regular',
  },
  card: {
    backgroundColor: COLORS.bg2,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
  },
  cardItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardIconContainer: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: COLORS.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  cardText: { flex: 1 },
  cardTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '600',
    fontFamily: 'Inter-Medium',
    marginBottom: 2,
  },
  cardDesc: {
    color: COLORS.textDim,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: 'Inter-Regular',
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 4,
  },
  noticeText: {
    flex: 1,
    color: COLORS.textDim,
    fontSize: 12,
    lineHeight: 18,
    fontFamily: 'Inter-Regular',
  },
  spacer: { flex: 1 },
  continueButton: {
    minHeight: 54,
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  continueButtonDisabled: { opacity: 0.7 },
  continueText: {
    color: COLORS.bg,
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 2,
    fontFamily: 'Inter-Medium',
  },
  skipButton: {
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  skipText: {
    color: COLORS.textDim,
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
});
