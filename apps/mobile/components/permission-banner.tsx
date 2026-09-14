// components/permission-banner.tsx
//
// PERM-DENIED — Reusable denial banner shown when a permission the feature
// needs was denied. The same component is used for every permission's denied
// state in this epic (contacts / notifications / microphone / camera /
// photos-files); copy is picked per `permissionId`.
//
// Rules baked in here:
//   - Dismissing hides it for the rest of the JS session (session-scoped, not
//     persisted — see lib/banner-dismissal.ts). Closing the app resets it.
//   - A Settings link is always present so the user can re-grant later.
import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useThemeContext } from '@/providers/ThemeProvider';
import { isBannerDismissed, dismissBanner } from '@/lib/banner-dismissal';

export type PermissionId = 'contacts' | 'notifications' | 'microphone' | 'camera' | 'photos-files';

const COPY: Record<PermissionId, { title: string; message: string }> = {
  contacts: {
    title: 'Contacts are off',
    message: 'You can still start chats by entering a phone number. Your address book won\u2019t be synced until you allow access.',
  },
  notifications: {
    title: 'Notifications are off',
    message: 'You may miss new-message alerts until notifications are allowed.',
  },
  microphone: {
    title: 'Microphone is off',
    message: 'Voice notes won\u2019t record until microphone access is allowed.',
  },
  camera: {
    title: 'Camera is off',
    message: 'Photos and video capture won\u2019t work until camera access is allowed.',
  },
  'photos-files': {
    title: 'Photos & Files are off',
    message: 'Sending images and files won\u2019t work until media access is allowed.',
  },
};

export function PermissionBanner({
  permissionId,
  onOpenSettings,
}: {
  permissionId: PermissionId;
  onOpenSettings?: () => void;
}) {
  const { colors } = useThemeContext();
  const [visible, setVisible] = useState(() => !isBannerDismissed(permissionId));

  if (!visible) {
    return null;
  }

  const copy = COPY[permissionId];

  const handleDismiss = () => {
    dismissBanner(permissionId);
    setVisible(false);
  };

  const openSettings = onOpenSettings ?? (() => Linking.openSettings());

  return (
    <View style={[s.banner, { backgroundColor: colors.bg3, borderColor: colors.border }]}>
      <View style={s.header}>
        <View style={s.titleRow}>
          <Ionicons name="alert-circle-outline" size={18} color={colors.error} />
          <Text style={[s.title, { color: colors.text }]}>{copy.title}</Text>
        </View>
        <Pressable
          onPress={handleDismiss}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification"
        >
          <Ionicons name="close" size={18} color={colors.textDim} />
        </Pressable>
      </View>

      <Text style={[s.message, { color: colors.textDim }]}>{copy.message}</Text>

      <Pressable
        style={[s.settingsButton, { backgroundColor: colors.accentDim }]}
        onPress={openSettings}
        accessibilityRole="button"
        accessibilityLabel="Open Settings"
      >
        <Ionicons name="settings-outline" size={15} color={colors.accent} />
        <Text style={[s.settingsText, { color: colors.accent }]}>Open Settings</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  banner: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 14, fontWeight: '600', fontFamily: 'Lato-Bold', flexShrink: 1 },
  message: { fontSize: 13, lineHeight: 19, fontFamily: 'Lato-Regular', marginTop: 8 },
  settingsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginTop: 12,
  },
  settingsText: { fontSize: 13, fontWeight: '600', fontFamily: 'Lato-Bold' },
});