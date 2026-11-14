import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { darkColors as COLORS } from '@/lib/theme';
import { Ionicons } from '@expo/vector-icons';
import { dismissBanner, useBannerDismissed } from '@/lib/banner-dismissal';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

export type PermissionId = 'contacts' | 'notifications' | 'microphone' | 'camera' | 'photos-files';

interface Props {
  permissionId: PermissionId;
}

const PERMISSION_COPY: Record<PermissionId, { title: string; desc: string; icon: IconName }> = {
  contacts: {
    title: 'Contacts access denied',
    desc: 'Your address book won\'t be synced until you allow access. You can still start a chat by number.',
    icon: 'people-outline',
  },
  notifications: {
    title: 'Notifications disabled',
    desc: 'You won\'t get alerts while the app is closed. Unread messages still show here.',
    icon: 'notifications-outline',
  },
  microphone: {
    title: 'Microphone access denied',
    desc: 'You can\'t record voice notes until you allow it. Text messages work as normal.',
    icon: 'mic-outline',
  },
  camera: {
    title: 'Camera access denied',
    desc: 'You can\'t take photos in a chat until you allow it. You can still attach photos from your gallery.',
    icon: 'camera-outline',
  },
  'photos-files': {
    title: 'Photos & Files access denied',
    desc: 'You can\'t attach photos, videos or files until you allow it. You can still take a photo with the camera.',
    icon: 'images-outline',
  },
};

// PERM-2.4 / PERM-2.14 — one reusable denial banner for all five permissions.
// Dismissal is session-scoped (lib/banner-dismissal.ts): hidden for the rest
// of this session once closed, back after an app restart. The Settings link
// is always present while the banner shows.
export function PermissionBanner({ permissionId }: Props) {
  const copy = PERMISSION_COPY[permissionId];
  const dismissed = useBannerDismissed(permissionId);
  if (dismissed) return null;

  const handleOpenSettings = () => {
    Linking.openSettings();
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Ionicons name={copy.icon} size={24} color={COLORS.accent} />
        </View>
        <View style={styles.textContainer}>
          <Text style={styles.title}>{copy.title}</Text>
          <Text style={styles.desc}>{copy.desc}</Text>
          <TouchableOpacity onPress={handleOpenSettings}>
            <Text style={styles.settingsLink}>Open Settings</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          onPress={() => dismissBanner(permissionId)}
          style={styles.closeButton}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={8}
        >
          <Ionicons name="close" size={20} color={COLORS.textDim} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.bg2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    padding: 16,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.accentDim,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  textContainer: {
    flex: 1,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: 2,
    fontFamily: 'Lato-Bold',
  },
  desc: {
    fontSize: 13,
    color: COLORS.textDim,
    lineHeight: 18,
    marginBottom: 8,
    fontFamily: 'Lato-Regular',
  },
  settingsLink: {
    fontSize: 13,
    color: COLORS.accent,
    fontWeight: '600',
    fontFamily: 'Lato-Bold',
  },
  closeButton: {
    padding: 4,
    marginLeft: 8,
  },
});
