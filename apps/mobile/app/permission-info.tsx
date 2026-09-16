// app/permission-info.tsx
//
// CONTACTS PERMISSION — Shown after profile setup and the permission intro,
// before the Notifications screen and the Chat List. Explains why Contacts
// access is useful, then triggers the native Contacts permission dialog. Only
// Contacts is requested here — Notifications follows on the next screen, and
// Microphone, Camera, and Photos/Files are each requested contextually later
// when their respective features are used.
//
// On grant: contact synchronization begins automatically (PERM-3).
// On deny: the user proceeds to Notifications; manual chat-by-number still
// works in the Chat List. Never blocks core messaging regardless of outcome.
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { requestContactsPermission, checkContactsState } from '@/lib/permissions';
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

export default function PermissionsInfoScreen() {
  const { phoneNumber, displayPhone } = useLocalSearchParams<{
    phoneNumber?: string;
    displayPhone?: string;
  }>();
  const [isRequesting, setIsRequesting] = useState(false);

  // ROUTE-GATE — authenticated-only screen (post-profile-setup).
  const snapshot = useRouteGuard('permission-info');

  const handleContinue = useCallback(async () => {
    if (isRequesting) return;
    setIsRequesting(true);

    try {
      const state = await checkContactsState();
      // Only prompt the native dialog when the user hasn't decided yet —
      // never re-request an already-granted or already-denied permission.
      let result;
      if (state === 'unknown') {
        result = await requestContactsPermission();
      }
      const sync = result?.contactSync;

      if (sync?.status === 'completed') {
        const msg = `Contacts synced · ${sync.matched} match${sync.matched === 1 ? '' : 'es'}`;
        Alert.alert('Contacts synced', msg, [{ text: 'OK' }]);
      } else if (sync?.status === 'failed') {
        Alert.alert(
          'Contacts sync incomplete',
          `We couldn't finish syncing your contacts (${sync.message}). ` +
            `You can continue now; they'll be retried later.`,
        );
      }
    } catch (e) {
      Alert.alert(
        'Contacts sync incomplete',
        e instanceof Error ? e.message : 'Contacts sync failed.',
      );
    } finally {
      router.replace({
        pathname: '/notifications-info',
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
              name="people-outline"
              size={30}
              color={COLORS.accent}
            />
          </View>

          <Text style={styles.title}>Find people you know</Text>

          <Text style={styles.subtitle}>
            Allow Contacts access to help you find people you already know on
            ONB. Your contacts are hashed locally and never shared in raw form.
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.cardItem}>
            <View style={styles.cardIconContainer}>
              <Ionicons name="search-outline" size={20} color={COLORS.accent} />
            </View>
            <View style={styles.cardText}>
              <Text style={styles.cardTitle}>Discover contacts</Text>
              <Text style={styles.cardDesc}>
                See which of your contacts are already on ONB.
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
            You can skip this and start chats manually by entering a phone
            number. You can always enable Contacts later in Settings.
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
          accessibilityLabel="Allow Contacts access"
        >
          {isRequesting ? (
            <ActivityIndicator color={COLORS.bg} size="small" />
          ) : (
            <>
              <Text style={styles.continueText}>ALLOW CONTACTS</Text>
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
