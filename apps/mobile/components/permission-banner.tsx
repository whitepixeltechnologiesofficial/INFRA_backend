import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { darkColors as COLORS } from '@/lib/theme';
import { Ionicons } from '@expo/vector-icons';

export type PermissionId = 'contacts' | 'notifications' | 'microphone' | 'camera' | 'photos-files';

interface Props {
  permissionId: PermissionId;
  onDismiss?: () => void;
}

const PERMISSION_COPY: Record<PermissionId, { title: string; desc: string; icon: keyof typeof Ionicons.prototype.props.name }> = {
  contacts: {
    title: 'Contacts access denied',
    desc: 'Your address book won\'t be synced until you allow access in settings.',
    icon: 'people-outline',
  },
  notifications: {
    title: 'Notifications disabled',
    desc: 'You won\'t receive alerts for new messages. Enable them in settings.',
    icon: 'notifications-outline',
  },
  microphone: {
    title: 'Microphone access denied',
    desc: 'You can\'t record voice notes. Allow microphone access in settings.',
    icon: 'mic-outline',
  },
  camera: {
    title: 'Camera access denied',
    desc: 'You can\'t take photos. Allow camera access in settings.',
    icon: 'camera-outline',
  },
  'photos-files': {
    title: 'Photos access denied',
    desc: 'You can\'t attach images from your gallery. Allow access in settings.',
    icon: 'images-outline',
  },
};

export function PermissionBanner({ permissionId, onDismiss }: Props) {
  const copy = PERMISSION_COPY[permissionId];

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
        {onDismiss && (
          <TouchableOpacity onPress={onDismiss} style={styles.closeButton}>
            <Ionicons name="close" size={20} color={COLORS.textDim} />
          </TouchableOpacity>
        )}
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
