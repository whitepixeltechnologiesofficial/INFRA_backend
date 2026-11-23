// app/permission-intro.tsx
//
// PERMISSION INTRO — Shown right after profile setup, before the Contacts
// and Notifications explainer screens. A short, informational overview of the
// five permissions the app may ask for and what each one is used for, so the
// user is not surprised by a sequence of native dialogs.
//
// This screen requests NOTHING — it is info-only and continue-only: no
// toggles, no checkboxes, no skip, no permanent dismissal. Continuing simply
// moves to the Contacts explainer (/permission-info), which then requests only
// Contacts. Notifications follows after that.
import React, { useCallback } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
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

const PERMISSION_ITEMS: {
  key: string;
  icon: 'people-outline' | 'notifications-outline' | 'mic-outline' | 'camera-outline' | 'images-outline';
  title: string;
  desc: string;
}[] = [
  {
    key: 'contacts',
    icon: 'people-outline',
    title: 'Contacts',
    desc: 'Find friends and people you can chat with.',
  },
  {
    key: 'notifications',
    icon: 'notifications-outline',
    title: 'Notifications',
    desc: 'Let you know when you receive a message.',
  },
  {
    key: 'microphone',
    icon: 'mic-outline',
    title: 'Microphone',
    desc: 'Record voice messages.',
  },
  {
    key: 'camera',
    icon: 'camera-outline',
    title: 'Camera',
    desc: 'Take photos directly in chats.',
  },
  {
    key: 'photos-files',
    icon: 'images-outline',
    title: 'Photos & Files',
    desc: 'Choose photos, videos, and files to send.',
  },
];

export default function PermissionIntroScreen() {
  const { phoneNumber, displayPhone } = useLocalSearchParams<{
    phoneNumber?: string;
    displayPhone?: string;
  }>();

  // ROUTE-GATE — authenticated-only screen (post-profile-setup).
  const snapshot = useRouteGuard('permission-intro');

  const handleContinue = useCallback(() => {
    router.replace({
      pathname: '/permission-info',
      params: { phoneNumber, displayPhone },
    });
  }, [phoneNumber, displayPhone]);

  if (!snapshot) return null;

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.content}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <View style={styles.headerIcon}>
              <Ionicons name="shield-checkmark-outline" size={30} color={COLORS.accent} />
            </View>

            <Text style={styles.title}>A few permissions</Text>

            <Text style={styles.subtitle}>
              To get the most out of ONB, we may ask you for access to the
              following. Each permission is optional — you can always change
              these later in Settings.
            </Text>
          </View>

          <View style={styles.card}>
            {PERMISSION_ITEMS.map((item, index) => (
              <View key={item.key}>
                {index > 0 && <View style={styles.divider} />}
                <View style={styles.cardItem}>
                  <View style={styles.cardIconContainer}>
                    <Ionicons name={item.icon} size={20} color={COLORS.accent} />
                  </View>
                  <View style={styles.cardText}>
                    <Text style={styles.cardTitle}>{item.title}</Text>
                    <Text style={styles.cardDesc}>{item.desc}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>

          <View style={styles.spacer} />

          <Pressable
            style={styles.continueButton}
            onPress={handleContinue}
            accessibilityRole="button"
            accessibilityLabel="Continue"
          >
            <Text style={styles.continueText}>CONTINUE</Text>
            <Ionicons name="arrow-forward" size={18} color={COLORS.bg} />
          </Pressable>
        </ScrollView>
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
  scrollContent: { flexGrow: 1 },
  header: { marginBottom: 24 },
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
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  cardItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
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
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: COLORS.border },
  spacer: { flex: 1 },
  continueButton: {
    minHeight: 54,
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 8,
  },
  continueText: {
    color: COLORS.bg,
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 2,
    fontFamily: 'Inter-Medium',
  },
});