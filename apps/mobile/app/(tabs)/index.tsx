import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  TouchableOpacity,
  TextInput,
  StatusBar,
  StatusBarStyle,
  Platform,
  Modal,
  Alert,
  Keyboard,
  ActivityIndicator,
  Linking,
  RefreshControl,
  Animated as RNAnimated,
  AppState,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useKeyboardHeight } from '@/hooks/use-keyboard-height';
import { useThemeContext } from '@/providers/ThemeProvider';
import { useSessionContext } from '@/providers/SessionProvider';
import * as Contacts from 'expo-contacts';
import type { ThemeColors } from '@/lib/theme';

import { PermissionBanner } from '@/components/permission-banner';
import { normalizeToE164, hashContactNumber } from '@/lib/contact-hash';
import { contactSyncApi, GLOBAL_SALT } from '@/api/mockContactSyncApi';
import { onIncomingMessage, onChatOpened } from '@/lib/unread';


import {
  requestRecordingPermissionsAsync,
  getRecordingPermissionsAsync,
  AudioModule,
  RecordingPresets,
  type AudioRecorder,
} from 'expo-audio';
import {
  classifyMicGranted,
  isUsableVoiceNote,
  formatVoiceDuration,
  buildVoiceNoteDraft,
  decideRecordAction,
  type MicGate,
  type VoiceNoteDraft,
} from '@/lib/voice-note';
import {
  requestCameraPermission,
  checkCameraState,
  requestPhotosPermission,
  checkPhotosState,
  checkNotificationsState,
  classifyFeatureGate,
  decideAttachAction,
  type FeatureGate,
} from '@/lib/permissions';
import { registerPushOnGrant } from '@/lib/push';

const FONTS = {
  heading: 'Lato-Black',
  body: 'Lato-Regular',
  bodyMedium: 'Lato-Bold',
};

// NOTIFICATIONS-DENIED VERIFY knob handle (Scenario 3.4/3.5 denied). The
// in-app unread state lives in this screen's React state, so — unlike the
// grant-path `simulateIncomingPush` (a pure lib export) — the deny-path knob
// is registered here and reached through `getSimulateIncomingMessageKnob()`
// from a devtools context to confirm live in-app badges with no push.
export type SimulateIncomingMessageResult = { chatId: string; opened: boolean; unreadTotal: number };
type SimulateIncomingMessageFn = () => SimulateIncomingMessageResult;

let simulateIncomingMessageHandle: SimulateIncomingMessageFn | null = null;

export function getSimulateIncomingMessageKnob(): SimulateIncomingMessageFn | null {
  return simulateIncomingMessageHandle;
}

interface Message {
  id: string;
  text: string;
  sent: boolean;
  time: string;
  dateKey: string;
  status?: 'sent' | 'delivered' | 'read';
  kind?: 'voice' | 'image';
  audioUri?: string;
  durationSec?: number;
  imageUri?: string;
}

interface Contact {
  id: string;
  name: string;
  phone: string;
  initials: string;
  avatar: string | null;
}

interface Chat {
  id: string;
  contact: Contact;
  messages: Message[];
  lastMessage?: string;
  lastMessageTime?: string;
  unreadCount?: number;
}

type ChatEntry = { message: Message } | { dateKey: string };

function getDateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function formatDateSeparator(dateKey: string): string {
  const parts = dateKey.split('-').map(Number);
  const d = new Date(parts[0], parts[1], parts[2]);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';

  const diff = Math.floor((today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diff < 7) {
    return d.toLocaleDateString(undefined, { weekday: 'long' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function shouldGroupMessages(a: Message, b: Message): boolean {
  if (a.sent !== b.sent) return false;
  const tA = a.time.split(':').map(Number);
  const tB = b.time.split(':').map(Number);
  const minsA = tA[0] * 60 + tA[1];
  const minsB = tB[0] * 60 + tB[1];
  return Math.abs(minsA - minsB) < 1;
}

function Header({
  colors,
  onSearchPress,
  onMenuPress,
}: {
  colors: ThemeColors;
  onSearchPress: () => void;
  onMenuPress: () => void;
}) {
  const { displayPhone } = useSessionContext();
  return (
    <View style={[s.header, { backgroundColor: colors.bg, borderBottomColor: colors.border }]}>
      <View>
        <Text style={[s.headerTitle, { color: colors.text }]}>Chats</Text>
        {displayPhone ? (
          <Text style={[s.headerSubtitle, { color: colors.textDim }]}>{displayPhone}</Text>
        ) : null}
      </View>
      <View style={s.headerRight}>
        <TouchableOpacity style={s.headerIcon} onPress={onSearchPress} hitSlop={8}>
          <Ionicons name="search-outline" size={22} color={colors.textDim} />
        </TouchableOpacity>
        <TouchableOpacity style={s.headerIcon} onPress={onMenuPress} hitSlop={8}>
          <Ionicons name="ellipsis-vertical" size={22} color={colors.textDim} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Avatar({
  contact,
  colors,
  size = 50,
  online,
}: {
  contact: Contact;
  colors: ThemeColors;
  size?: number;
  online?: boolean;
}) {
  const r = size / 2;
  return (
    <View style={{ position: 'relative', marginRight: 14 }}>
      {contact.avatar ? (
        <Image source={{ uri: contact.avatar }} style={{ width: size, height: size, borderRadius: r }} />
      ) : (
        <View
          style={[
            s.avatarPlaceholder,
            { width: size, height: size, borderRadius: r, backgroundColor: colors.accentDim, borderColor: colors.border },
          ]}
        >
          <Text style={[s.avatarText, { color: colors.accent, fontSize: size * 0.38 }]}>
            {contact.initials}
          </Text>
        </View>
      )}
      {online && (
        <View
          style={[
            s.onlineDot,
            {
              backgroundColor: '#22C55E',
              width: size * 0.24,
              height: size * 0.24,
              borderRadius: size * 0.12,
              borderWidth: 2,
              borderColor: colors.bg,
            },
          ]}
        />
      )}
    </View>
  );
}

function ChatItem({
  chat,
  colors,
  unread,
  onPress,
}: {
  chat: Chat;
  colors: ThemeColors;
  unread: number;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[s.chatItem, { borderBottomColor: colors.borderSoft }]}
      activeOpacity={0.6}
      onPress={onPress}
    >
      <Avatar contact={chat.contact} colors={colors} />
      <View style={s.chatInfo}>
        <View style={s.chatTop}>
          <Text style={[s.chatName, { color: colors.text }]} numberOfLines={1}>
            {chat.contact.name}
          </Text>
          <Text style={[s.chatTime, { color: unread > 0 ? colors.accent : colors.textDim }]}>
            {chat.lastMessageTime || ''}
          </Text>
        </View>
        <View style={s.chatBottom}>
          <Text style={[s.chatMessage, { color: colors.textDim }]} numberOfLines={1}>
            {chat.lastMessage || 'No messages yet'}
          </Text>
          {unread > 0 ? (
            <View style={[s.unreadBadge, { backgroundColor: colors.accent }]}>
              <Text style={s.unreadText}>{unread}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );
}

function EmptyState({ colors }: { colors: ThemeColors }) {
  return (
    <View style={s.emptyContainer}>
      <View style={[s.emptyIconContainer, { backgroundColor: colors.accentDim, borderColor: colors.border }]}>
        <Ionicons name="chatbubbles-outline" size={48} color={colors.accent} />
      </View>
      <Text style={[s.emptyTitle, { color: colors.text }]}>No chats yet</Text>
      <Text style={[s.emptySubtitle, { color: colors.textDim }]}>
        Tap the button below to start a conversation.
      </Text>
    </View>
  );
}

function ContactPickerModal({
  visible,
  onClose,
  onSelectContact,
  onManualChat,
  loading,
  contacts,
  permissionDenied,
  onRequestPermission,
  onOpenSettings,
  colors,
}: {
  visible: boolean;
  onClose: () => void;
  onSelectContact: (contact: Contact) => void;
  onManualChat: (rawNumber: string) => Promise<string | null>;
  loading: boolean;
  contacts: Contact[];
  permissionDenied: boolean;
  onRequestPermission: () => void;
  onOpenSettings: () => void;
  colors: ThemeColors;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [manualNumber, setManualNumber] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualChecking, setManualChecking] = useState(false);

  const filtered = contacts.filter(
    (c) =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.phone.includes(searchQuery),
  );

  const renderItem = ({ item }: { item: Contact }) => (
    <TouchableOpacity
      style={[s.contactItem, { borderBottomColor: colors.borderSoft }]}
      onPress={() => { onSelectContact(item); onClose(); }}
    >
      <Avatar contact={item} colors={colors} size={44} />
      <View style={s.contactInfo}>
        <Text style={[s.contactName, { color: colors.text }]}>{item.name}</Text>
        <Text style={[s.contactPhone, { color: colors.textDim }]}>{item.phone}</Text>
      </View>
    </TouchableOpacity>
  );

  const handleManualStart = async () => {
    if (manualChecking) return;
    const raw = manualNumber.trim();
    if (!raw) return;
    setManualChecking(true);
    setManualError(null);
    try {
      const error = await onManualChat(raw);
      if (error) {
        setManualError(error);
        return;
      }
      setManualNumber('');
      onClose();
    } catch {
      setManualError('Could not start a chat with this number. Please try again.');
    } finally {
      setManualChecking(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      <SafeAreaView style={[s.modalContainer, { backgroundColor: colors.bg }]}>
        <View style={[s.modalHeader, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={onClose} style={s.modalBackButton}>
            <Ionicons name="close" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={[s.modalTitle, { color: colors.text }]}>Select contact</Text>
          <View style={{ width: 28 }} />
        </View>

        {permissionDenied ? (
          // CONTACTS-DENIED STATE (Scenario 3.2/3.3, PRD §5.4, Tech Arch §14.3):
          // no synced contact list exists to show. A session-dismissible banner
          // explains the gap, and manual entry stays fully functional — reusing
          // the same matching endpoint PERM-2.3 uses with a one-item batch.
          <View style={s.modalDenied}>
            <PermissionBanner permissionId="contacts" onOpenSettings={onOpenSettings} />

            <Text style={[s.manualTitle, { color: colors.text }]}>Start a chat by number</Text>
            <Text style={[s.manualHint, { color: colors.textDim }]}>
              Enter a phone number. It will be matched against registered users
              before a chat can start.
            </Text>

            <View style={[s.manualInputRow, { backgroundColor: colors.searchBg, borderColor: colors.border }]}>
              <Ionicons name="call-outline" size={18} color={colors.textDim} />
              <TextInput
                style={[s.manualInput, { color: colors.text }]}
                value={manualNumber}
                onChangeText={(t) => { setManualNumber(t); if (manualError) setManualError(null); }}
                placeholder="+1 415 555 2671"
                placeholderTextColor={colors.textMuted}
                keyboardType="phone-pad"
                autoCapitalize="none"
                editable={!manualChecking}
              />
            </View>

            {manualError ? (
              <Text style={[s.manualError, { color: colors.error }]}>{manualError}</Text>
            ) : null}

            <TouchableOpacity
              style={[s.manualStartButton, { backgroundColor: colors.accent }]}
              onPress={handleManualStart}
              disabled={manualChecking}
              activeOpacity={0.7}
            >
              {manualChecking ? (
                <ActivityIndicator color={colors.bg} size="small" />
              ) : (
                <>
                  <Text style={[s.manualStartText, { color: colors.bg }]}>START CHAT</Text>
                  <Ionicons name="arrow-forward" size={18} color={colors.bg} />
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : loading ? (
          <View style={s.modalEmpty}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={[s.modalEmptyText, { color: colors.textDim }]}>Loading contacts...</Text>
          </View>
        ) : (
          <>
            <View style={[s.searchContainer, { backgroundColor: colors.bg, borderBottomColor: colors.border }]}>
              <View style={[s.searchInputContainer, { backgroundColor: colors.searchBg, borderColor: colors.border }]}>
                <Ionicons name="search" size={18} color={colors.textDim} />
                <TextInput
                  style={[s.searchInput, { color: colors.text }]}
                  placeholder="Search contacts..."
                  placeholderTextColor={colors.textDim}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                />
              </View>
            </View>
            <FlatList
              data={filtered}
              keyExtractor={(item) => item.id}
              renderItem={renderItem}
              contentContainerStyle={s.modalList}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                <Text style={[s.modalEmptyText, { color: colors.textDim }]}>No contacts found</Text>
              }
            />
          </>
        )}
      </SafeAreaView>
    </Modal>
  );
}

function MessageBubble({
  item,
  colors,
  isGrouped,
}: {
  item: Message;
  colors: ThemeColors;
  isGrouped: boolean;
}) {
  return (
    <View
      style={[
        s.messageRow,
        item.sent ? s.messageRowSent : s.messageRowReceived,
        isGrouped && { marginBottom: 3 },
      ]}
    >
      <View
        style={[
          s.messageBubble,
          item.sent
            ? [s.sentBubble, { backgroundColor: colors.outgoingBubble }]
            : [s.receivedBubble, { backgroundColor: colors.incomingBubble }],
          isGrouped && item.sent && { borderTopRightRadius: 16 },
          isGrouped && !item.sent && { borderTopLeftRadius: 16 },
        ]}
      >
        {item.kind === 'image' ? (
          <Image
            source={{ uri: item.imageUri }}
            style={[s.messageImage, { borderColor: item.sent ? 'rgba(0,0,0,0.1)' : colors.incomingBubble }]}
          />
        ) : item.kind === 'voice' ? (
          <View style={s.voiceNoteRow}>
            <Ionicons
              name="mic"
              size={18}
              color={item.sent ? (colors.outgoingBubble === '#3FC6B8' ? '#0B0F14' : colors.text) : colors.text}
              style={{ marginRight: 6 }}
            />
            <Text
              style={[
                s.voiceNoteText,
                { color: item.sent ? (colors.outgoingBubble === '#3FC6B8' ? '#0B0F14' : colors.text) : colors.text },
              ]}
            >
              {typeof item.durationSec === 'number' ? formatVoiceDuration(item.durationSec) : '0:00'}
            </Text>
          </View>
        ) : (
          <Text style={[s.messageText, { color: item.sent ? (colors.outgoingBubble === '#3FC6B8' ? '#0B0F14' : colors.text) : colors.text }]}>
            {item.text}
          </Text>
        )}
        <View style={s.messageMeta}>
          <Text style={[s.messageTime, { color: item.sent ? 'rgba(0,0,0,0.45)' : colors.textDim }]}>
            {item.time}
          </Text>
          {item.sent && (
            <Ionicons
              name={
                item.status === 'read'
                  ? 'checkmark-done'
                  : item.status === 'delivered'
                  ? 'checkmark-done'
                  : 'checkmark'
              }
              size={14}
              color={item.status === 'read' ? '#53BDEB' : item.sent ? 'rgba(0,0,0,0.35)' : colors.textDim}
              style={{ marginLeft: 3 }}
            />
          )}
        </View>
      </View>
    </View>
  );
}

function TypingIndicator({ colors }: { colors: ThemeColors }) {
  const anim = useRef(new RNAnimated.Value(0)).current;

  useEffect(() => {
    const loop = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(anim, { toValue: 1, duration: 400, useNativeDriver: true }),
        RNAnimated.timing(anim, { toValue: 0, duration: 400, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);

  const dotStyle = (delay: number) => ({
    opacity: anim.interpolate({
      inputRange: [0, 1],
      outputRange: [0.3, 0.9],
    }),
    transform: [
      {
        translateY: anim.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -3],
        }),
      },
    ],
  });

  return (
    <View style={[s.typingContainer]}>
      <View style={[s.messageBubble, s.receivedBubble, { backgroundColor: colors.incomingBubble }]}>
        <View style={s.typingDots}>
          <RNAnimated.View style={[s.typingDot, { backgroundColor: colors.textDim }, dotStyle(0)]} />
          <RNAnimated.View style={[s.typingDot, { backgroundColor: colors.textDim }, dotStyle(100)]} />
          <RNAnimated.View style={[s.typingDot, { backgroundColor: colors.textDim }, dotStyle(200)]} />
        </View>
      </View>
    </View>
  );
}

function ChatView({
  chat,
  colors,
  onBack,
  setChatMessages,
}: {
  chat: Chat;
  colors: ThemeColors;
  onBack: () => void;
  setChatMessages: (chatId: string, messages: Message[]) => void;
}) {
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [micGate, setMicGate] = useState<MicGate>('undetermined');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const flatListRef = useRef<FlatList>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardHeight = useKeyboardHeight();

  // MIC NO-PREINIT (PERM-2.7): the OS recorder is created LAZILY — only once
  // the microphone is confirmed granted AND the user presses/holds the mic. It
  // is never constructed at mount or while denied/undetermined, so no
  // microphone functionality exists before permission is confirmed. The
  // recorder is released on unmount and reused for subsequent recordings.
  const recorderRef = useRef<AudioRecorder | null>(null);
  const ensureRecorder = useCallback((): AudioRecorder | null => {
    if (recorderRef.current) return recorderRef.current;
    // expo-audio's web shim names the recorder class differently; the mic
    // feature is native-only, so on web there is nothing to construct.
    const RecorderCtor = (AudioModule as unknown as {
      AudioRecorder?: typeof AudioRecorder;
    }).AudioRecorder;
    if (typeof RecorderCtor !== 'function') return null;
    recorderRef.current = new RecorderCtor(RecordingPresets.HIGH_QUALITY);
    return recorderRef.current;
  }, []);

  useEffect(() => {
    return () => {
      recorderRef.current?.release();
      recorderRef.current = null;
    };
  }, []);

  // Live recording timer: poll `currentTime` while recording so the duration
  // shown in the input bar stays live even though the recorder is a ref.
  const [, setRecTick] = useState(0);
  useEffect(() => {
    if (!isRecording) return;
    const t = setInterval(() => setRecTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [isRecording]);

  // MIC-STATE — the OS is the source of truth for microphone permission, never
  // stale app state. Re-query the actual OS permission on every foreground
  // return so that granting in Settings is picked up immediately (no restart,
  // no reinstall) and clearing the stale denied state. Registered once; the
  // mounted recorder remains uninitialized — recording still waits for the
  // user's next explicit Voice Note action.
  const syncMicGate = useCallback(async () => {
    let gate: MicGate;
    try {
      const res = await getRecordingPermissionsAsync();
      gate = classifyMicGranted(res.granted, res.status);
    } catch {
      gate = 'undetermined';
    }
    setMicGate(gate);
  }, []);

  useEffect(() => {
    syncMicGate();
  }, [syncMicGate]);

  // CAMERA/PHOTOS gates — same source-of-truth rule as the mic: cache the
  // CURRENT OS permission (checked on mount and re-queried on every foreground
  // return, so granting in Settings is picked up without a restart). A cached
  // 'granted' lets the feature launch immediately; any other state goes through
  // the OS permission request (a native dialog when the OS was never asked).
  const [cameraGate, setCameraGate] = useState<FeatureGate>('undetermined');
  const [photosGate, setPhotosGate] = useState<FeatureGate>('undetermined');

  const syncCameraGate = useCallback(async () => {
    let gate: FeatureGate;
    try {
      gate = classifyFeatureGate(await checkCameraState());
    } catch {
      gate = 'undetermined';
    }
    setCameraGate(gate);
  }, []);

  const syncPhotosGate = useCallback(async () => {
    let gate: FeatureGate;
    try {
      gate = classifyFeatureGate(await checkPhotosState());
    } catch {
      gate = 'undetermined';
    }
    setPhotosGate(gate);
  }, []);

  useEffect(() => {
    syncCameraGate();
  }, [syncCameraGate]);

  useEffect(() => {
    syncPhotosGate();
  }, [syncPhotosGate]);

  // FOREGROUND RE-QUERY (PERM-STATE): whenever the app returns from the
  // background — e.g. the OS Settings after a denied permission was changed —
  // ALWAYS re-read the actual OS permission state for every feature. React
  // state is never the source of truth; stale previous results are discarded.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        syncMicGate();
        syncCameraGate();
        syncPhotosGate();
      }
    });
    return () => sub.remove();
  }, [syncMicGate, syncCameraGate, syncPhotosGate]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [chat.messages, scrollToBottom]);

  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', scrollToBottom);
    return () => sub.remove();
  }, [scrollToBottom]);

  const sendMessage = () => {
    if (!inputText.trim()) return;
    const now = new Date();
    const newMsg: Message = {
      id: `m${Date.now()}`,
      text: inputText.trim(),
      sent: true,
      time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      dateKey: getDateKey(now),
      status: 'sent',
    };
    const updatedMessages = [...chat.messages, newMsg];
    setChatMessages(chat.id, updatedMessages);
    setInputText('');

    // Simulate delivery
    setTimeout(() => {
      setChatMessages(
        chat.id,
        updatedMessages.map((m) => (m.id === newMsg.id ? { ...m, status: 'delivered' } : m)),
      );
    }, 600);

    // Simulate reply
    setIsTyping(true);
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => {
      setIsTyping(false);
      const replies = [
        "That's great!",
        'Got it, thanks!',
        'Sounds good to me.',
        'I agree.',
        'Let me think about that.',
        'Sure, no problem.',
        "I'll get back to you.",
        'Awesome!',
      ];
      const replyTime = new Date();
      const reply: Message = {
        id: `m${Date.now() + 1}`,
        text: replies[Math.floor(Math.random() * replies.length)],
        sent: false,
        time: replyTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        dateKey: getDateKey(replyTime),
      };
      const newMessages = [...updatedMessages, reply];
      setChatMessages(chat.id, newMessages);
      // Mark original as read
      setTimeout(() => {
        setChatMessages(
          chat.id,
          newMessages.map((m) => (m.id === newMsg.id ? { ...m, status: 'read' } : m)),
        );
      }, 300);
    }, 1000 + Math.random() * 1500);
  };

  const sendVoiceNote = useCallback(
    (draft: VoiceNoteDraft) => {
      const now = new Date();
      const newMsg: Message = {
        id: draft.id,
        text: '',
        sent: true,
        time: draft.time,
        dateKey: getDateKey(now),
        status: 'sent',
        kind: 'voice',
        audioUri: draft.audioUri,
        durationSec: draft.durationSec,
      };
      const updatedMessages = [...chat.messages, newMsg];
      setChatMessages(chat.id, updatedMessages);
      setTimeout(() => {
        setChatMessages(
          chat.id,
          updatedMessages.map((m) => (m.id === newMsg.id ? { ...m, status: 'delivered' } : m)),
        );
      }, 600);
    },
    [chat, setChatMessages],
  );

  const promptMicSettings = useCallback(() => {
    Alert.alert(
      'Microphone access needed',
      "To record a voice note, allow Microphone access in your device's Settings.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Settings', onPress: () => Linking.openSettings() },
      ],
    );
  }, []);

  // CONTEXTUAL CAMERA (PERM-2.9/2.10): the camera is ONLY initialized after the
  // permission is granted — never before. Denial guides to Settings and records
  // nothing; the rest of chat keeps working.
  const promptCameraSettings = useCallback(() => {
    Alert.alert(
      'Camera access needed',
      "To send a photo, allow Camera access in your device's Settings.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Settings', onPress: () => Linking.openSettings() },
      ],
    );
  }, []);

  const sendImage = useCallback(
    (uri: string) => {
      const now = new Date();
      const newMsg: Message = {
        id: `img${Date.now()}`,
        text: '',
        sent: true,
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        dateKey: getDateKey(now),
        status: 'sent',
        kind: 'image',
        imageUri: uri,
      };
      const updatedMessages = [...chat.messages, newMsg];
      setChatMessages(chat.id, updatedMessages);
      setTimeout(() => {
        setChatMessages(
          chat.id,
          updatedMessages.map((m) => (m.id === newMsg.id ? { ...m, status: 'delivered' } : m)),
        );
      }, 600);
    },
    [chat, setChatMessages],
  );

  const handleAttachCamera = useCallback(async () => {
    try {
      // THREE-STATE (PERM-2.9): granted -> launch immediately; undetermined ->
      // native OS request first; denied -> guidance + Settings. Settings is
      // NEVER shown for a first-time request while the OS can still be asked.
      let action = decideAttachAction(cameraGate);
      if (action === 'ask') {
        const res = await requestCameraPermission();
        if (res.granted) setCameraGate('granted');
        action = decideAttachAction(cameraGate, res);
      }
      if (action !== 'open') {
        promptCameraSettings();
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        sendImage(result.assets[0].uri);
      }
    } catch {
      Alert.alert('Error', 'Could not take a photo.');
    }
  }, [cameraGate, sendImage, promptCameraSettings]);

  // CONTEXTUAL PHOTOS/FILES (PERM-2.11/2.12): the picker is opened ONLY after
  // the Photos/Files permission is granted.
  const promptPhotosSettings = useCallback(() => {
    Alert.alert(
      'Media access needed',
      "To send a photo, allow Media access in your device's Settings.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Settings', onPress: () => Linking.openSettings() },
      ],
    );
  }, []);

  const handleAttachGallery = useCallback(async () => {
    try {
      // THREE-STATE (PERM-2.11): granted/limited -> launch immediately;
      // undetermined -> native OS request first; denied -> guidance + Settings.
      // Settings is NEVER shown for a first-time request while the OS can still
      // be asked. iOS `limited` maps to granted in the permission helpers.
      let action = decideAttachAction(photosGate);
      if (action === 'ask') {
        const res = await requestPhotosPermission();
        if (res.granted) setPhotosGate('granted');
        action = decideAttachAction(photosGate, res);
      }
      if (action !== 'open') {
        promptPhotosSettings();
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        sendImage(result.assets[0].uri);
      }
    } catch {
      Alert.alert('Error', 'Could not pick an image.');
    }
  }, [photosGate, sendImage, promptPhotosSettings]);

  // Attachment chooser: offers camera (Camera permission) and gallery (Photos/
  // Files permission) as separate, contextual requests.
  const openAttachmentSheet = useCallback(() => {
    Alert.alert(
      'Attach',
      'Choose an option',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Camera', onPress: handleAttachCamera },
        { text: 'Gallery', onPress: handleAttachGallery },
      ],
    );
  }, [handleAttachCamera, handleAttachGallery]);

  const tryStartRecording = useCallback(async () => {
    setRecordingError(null);
    const action = decideRecordAction(micGate);
    if (action === 'denied') {
      // PERM-2.7 — denied/blocked: never record; direct the user to Settings.
      promptMicSettings();
      return;
    }
    if (action === 'request') {
      // undetermined — first ask (grant path, Scenario 3.6/3.7).
      let res: { granted: boolean; status: string };
      try {
        res = await requestRecordingPermissionsAsync();
      } catch {
        setRecordingError("Couldn't start recording.");
        return;
      }
      const gate = classifyMicGranted(res.granted, res.status);
      setMicGate(gate);
      if (decideRecordAction(gate) !== 'record') {
        promptMicSettings();
        return;
      }
    }
    // Only reachable when the microphone is granted — record() is never called
    // while denied, so no audio is captured behind the permission check. The
    // recorder is created here, at the very last moment before capture.
    const recorder = ensureRecorder();
    if (!recorder) {
      setRecordingError("Couldn't start recording.");
      return;
    }
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch {
      setRecordingError("Couldn't start recording.");
      return;
    }
    setIsRecording(true);
  }, [micGate, ensureRecorder, promptMicSettings]);

  const tryStopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    try {
      await recorder.stop();
    } catch {
      // ignore cleanup errors
    }
    setIsRecording(false);
  }, []);

  const stopAndDiscard = useCallback(async () => {
    await tryStopRecording();
  }, [tryStopRecording]);

  const stopAndSend = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) {
      setRecordingError("Couldn't finish the recording.");
      setIsRecording(false);
      return;
    }
    let uri: string | null = null;
    let durationSec = 0;
    try {
      await recorder.stop();
      uri = recorder.uri;
      durationSec = recorder.currentTime;
    } catch {
      setRecordingError("Couldn't finish the recording.");
    }
    setIsRecording(false);
    if (uri && isUsableVoiceNote(durationSec)) {
      sendVoiceNote(buildVoiceNoteDraft(uri, durationSec));
    } else if (uri) {
      setRecordingError('Voice note too short to send.');
    }
  }, [sendVoiceNote]);

  // Press-and-hold to record (Scenarios 3.6/3.7): holding the mic starts
  // recording on grant, releasing sends. When denied it never records and
  // instead prompts the user to enable the permission in Settings.
  const handleMicPressIn = useCallback(() => {
    if (isRecording) return;
    tryStartRecording();
  }, [isRecording, tryStartRecording]);

  const handleMicPressOut = useCallback(() => {
    if (isRecording) {
      stopAndSend();
    }
  }, [isRecording, stopAndSend]);

  const handleScroll = (e: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const isAtBottom = contentSize.height - layoutMeasurement.height - contentOffset.y < 80;
    setShowScrollDown(!isAtBottom);
  };

  const renderItem = ({ item, index }: { item: ChatEntry; index: number }) => {
    if ('message' in item) {
      const prev = index > 0 ? chat.messages[index - 1] : null;
      const isGrouped = prev ? shouldGroupMessages(prev, item.message) : false;
      return <MessageBubble item={item.message} colors={colors} isGrouped={isGrouped} />;
    }
    return (
      <View style={s.dateSeparatorContainer}>
        <View style={[s.dateSeparatorPill, { backgroundColor: colors.card }]}>
          <Text style={[s.dateSeparatorText, { color: colors.textDim }]}>{formatDateSeparator(item.dateKey)}</Text>
        </View>
      </View>
    );
  };

  const chatEntries: ChatEntry[] = useMemo(() => {
    const entries: ChatEntry[] = [];
    let lastDateKey = '';
    chat.messages.forEach((msg) => {
      if (msg.dateKey !== lastDateKey) {
        entries.push({ dateKey: msg.dateKey });
        lastDateKey = msg.dateKey;
      }
      entries.push({ message: msg });
    });
    return entries;
  }, [chat.messages]);

  const hasText = inputText.trim().length > 0;

  return (
    <View style={[s.chatView, { backgroundColor: colors.bg }]}>
      <View style={[s.chatHeader, { backgroundColor: colors.bg2, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={onBack} style={s.backButton}>
          <Ionicons name="chevron-back" size={26} color={colors.accent} />
        </TouchableOpacity>
        <Avatar contact={chat.contact} colors={colors} size={38} online />
        <View style={s.chatHeaderInfo}>
          <Text style={[s.chatHeaderName, { color: colors.text }]}>{chat.contact.name}</Text>
          <Text style={[s.chatHeaderStatus, { color: colors.textDim }]}>online</Text>
        </View>
        <TouchableOpacity style={s.chatHeaderIcon}>
          <Ionicons name="call-outline" size={22} color={colors.textDim} />
        </TouchableOpacity>
        <TouchableOpacity style={[s.chatHeaderIcon, { marginLeft: 8 }]}>
          <Ionicons name="ellipsis-vertical" size={22} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      <View style={s.chatBody}>
        <FlatList
          ref={flatListRef}
          data={chatEntries}
          keyExtractor={(item, index) => ('message' in item ? item.message.id : `date-${item.dateKey}-${index}`)}
          renderItem={renderItem}
          contentContainerStyle={[s.messagesList, { paddingBottom: 80 + keyboardHeight }]}
          ListFooterComponent={isTyping ? <TypingIndicator colors={colors} /> : null}
          showsVerticalScrollIndicator={false}
          onScroll={handleScroll}
          scrollEventThrottle={16}
        />

        {showScrollDown && (
          <TouchableOpacity
            style={[s.scrollDownFab, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={scrollToBottom}
          >
            <Ionicons name="chevron-down" size={22} color={colors.textDim} />
          </TouchableOpacity>
        )}

        <View style={[s.inputBar, { backgroundColor: colors.bg2, borderTopColor: colors.border, paddingBottom: keyboardHeight > 0 ? keyboardHeight + 8 : 12 }]}>
          {isRecording ? (
            <>
              <TouchableOpacity style={s.attachButton} onPress={stopAndDiscard}>
                <Ionicons name="close-circle" size={28} color={colors.textDim} />
              </TouchableOpacity>
              <View style={[s.recordingState, { backgroundColor: colors.inputBg, borderColor: colors.border }]}>
                <View style={[s.recordingDot, { backgroundColor: colors.accent }]} />
                <Text style={[s.recordingText, { color: colors.text }]}>Recording…</Text>
                <Text style={[s.recordingTimer, { color: colors.textDim }]}>
                  {formatVoiceDuration(recorderRef.current?.currentTime ?? 0)}
                </Text>
              </View>
              <TouchableOpacity
                style={[s.sendButton, { backgroundColor: colors.accent }]}
                onPress={stopAndSend}
              >
                <Ionicons name="send" size={20} color={colors.bg} />
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity style={s.attachButton} onPress={openAttachmentSheet}>
                <Ionicons name="add-circle-outline" size={28} color={colors.textDim} />
              </TouchableOpacity>
              <View style={[s.inputFieldContainer, { backgroundColor: colors.inputBg, borderColor: colors.border }]}>
                <TextInput
                  style={[s.inputField, { color: colors.text }]}
                  placeholder="Type a message..."
                  placeholderTextColor={colors.textMuted}
                  value={inputText}
                  onChangeText={setInputText}
                  returnKeyType="send"
                  onSubmitEditing={sendMessage}
                  multiline
                />
                {recordingError ? (
                  <Text style={[s.recordingError, { color: colors.danger }]} numberOfLines={2}>
                    {recordingError}
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity
                style={[s.sendButton, { backgroundColor: hasText ? colors.accent : colors.accentDim }]}
                onPress={hasText ? sendMessage : undefined}
                onPressIn={!hasText ? handleMicPressIn : undefined}
                onPressOut={!hasText ? handleMicPressOut : undefined}
              >
                <Ionicons
                  name={hasText ? 'send' : 'mic'}
                  size={20}
                  color={hasText ? colors.bg : colors.accent}
                />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

export default function ChatListScreen() {
  const { colors } = useThemeContext();
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [chats, setChats] = useState<Chat[]>([]);
  const [draftChat, setDraftChat] = useState<Chat | null>(null);

  // NOTIFICATIONS-DENIED unread state (Scenario 3.4/3.5 denied): a separate
  // chatId -> count map so live in-app badges stay accurate even though no push
  // can fire. Accounting lives in lib/unread.ts (pure + node-verifiable).
  const [unreadByChat, setUnreadByChat] = useState<Record<string, number>>({});

  const [showContactPicker, setShowContactPicker] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [notificationsDenied, setNotificationsDenied] = useState(false);

  const setChatMessages = useCallback(
    (chatId: string, messages: Message[]) => {
      const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
      const stamp = {
        lastMessage: lastMsg ? lastMsg.text : '',
        lastMessageTime: lastMsg ? lastMsg.time : '',
      };

      setDraftChat((prev) => (prev && prev.id === chatId ? null : prev));

      // In-app unread accuracy (NOTIFICATIONS-DENIED, Scenario 3.4/3.5): a
      // message that lands on a chat the user is not currently viewing bumps
      // that chat's badge — live, with no push involved. Messages on the open
      // chat are being read and add nothing.
      const incoming = lastMsg && !lastMsg.sent;
      if (incoming && selectedChatId !== chatId) {
        setUnreadByChat((prev) => onIncomingMessage(prev, chatId, false));
      }

      setChats((prev) => {
        if (prev.some((c) => c.id === chatId)) {
          return prev.map((c) => (c.id === chatId ? { ...c, messages, ...stamp } : c));
        }
        if (!draftChat || draftChat.id !== chatId) return prev;
        return [{ ...draftChat, messages, ...stamp }, ...prev];
      });
    },
    [draftChat, selectedChatId],
  );

  const loadContactsForPicker = useCallback(async () => {
    setLoadingContacts(true);
    setPermissionDenied(false);
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== 'granted') {
        setPermissionDenied(true);
        setLoadingContacts(false);
        return;
      }
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers, Contacts.Fields.Image],
      });
      const contactList: Contact[] = data
        .filter((c) => c.phoneNumbers && c.phoneNumbers.length > 0)
        .map((c) => {
          const name = c.name || 'Unknown';
          const phone = c.phoneNumbers?.[0]?.number || '';
          const initials = name
            .split(' ')
            .map((n) => n[0])
            .join('')
            .toUpperCase()
            .slice(0, 2);
          return { id: c.id || `contact-${Date.now()}`, name, phone, initials, avatar: c.image?.uri || null };
        });
      setContacts(contactList);
    } catch {
      Alert.alert('Error', 'Could not load contacts.');
    } finally {
      setLoadingContacts(false);
    }
  }, []);

  const openContactPicker = async () => {
    setShowContactPicker(true);
    await loadContactsForPicker();
  };

  // NOTIFICATIONS-DENIED (Scenario 3.4/3.5): opening a chat clears its in-app
  // badge — unread state must match what the user has actually read.
  const openChat = useCallback((chatId: string) => {
    setSelectedChatId(chatId);
    setUnreadByChat((prev) => onChatOpened(prev, chatId));
  }, []);

  const selectContact = useCallback(
    (contact: Contact) => {
      setShowContactPicker(false);
      const phoneDigits = contact.phone.replace(/\D/g, '');
      const existingChat = chats.find(
        (c) => c.contact.id === contact.id || c.contact.phone.replace(/\D/g, '') === phoneDigits,
      );
      if (existingChat) {
        setDraftChat(null);
        openChat(existingChat.id);
        return;
      }
      if (draftChat && draftChat.contact.phone.replace(/\D/g, '') === phoneDigits) {
        openChat(draftChat.id);
        return;
      }
      const newChat: Chat = {
        id: `chat-${Date.now()}`,
        contact,
        messages: [],
      };
      setDraftChat(newChat);
      setSelectedChatId(newChat.id);
    },
    [chats, draftChat, openChat],
  );

  // CONTACTS-DENIED MANUAL ENTRY (Scenario 3.2/3.3, PRD §5.4, Tech Arch §14.3):
  // Starting a chat requires a checked number, not unchecked free text. The raw
  // input is normalized to E.164, hashed, and sent to the SAME matching
  // endpoint PERM-2.3 uses — as a one-item batch. Only a match yields a chat.
  const handleManualChat = useCallback(
    async (raw: string): Promise<string | null> => {
      const e164 = normalizeToE164(raw) ?? normalizeToE164(raw, 'US');
      if (!e164) {
        return 'Enter a valid international number, e.g. +1 415 555 2671.';
      }

      let matched = false;
      try {
        const hash = hashContactNumber(e164, GLOBAL_SALT);
        const res = await contactSyncApi.syncContactHashes([hash]);
        matched = res.matched > 0;
      } catch {
        return 'Could not verify this number right now. Please try again.';
      }

      if (!matched) {
        return 'This number isn\u2019t registered on ONB yet.';
      }

      selectContact({
        id: `manual-${e164}`,
        name: e164,
        phone: e164,
        initials: e164.replace(/\D/g, '').slice(-2) || '?',
        avatar: null,
      });
      return null;
    },
    [selectContact],
  );

  // NOTIFICATIONS-DENIED VERIFY knob (Scenario 3.4/3.5 denied): the in-app
  // mirror of the grant-path `simulateIncomingPush`. With the app foregrounded
  // (Notifications denied, so no push can fire) this injects a fresh incoming
  // message onto a chat and bumps its unread badge live — proving the app never
  // silently fails to show unread messages it can render in-app. If the chat is
  // currently open nothing is badged (you are already reading it).
  const simulateIncomingMessage = useCallback((): { chatId: string; opened: boolean; unreadTotal: number } => {
    const target = chats[0] ?? draftChat;
    if (!target) throw new Error('NO_CHAT — open or start a chat first');

    const now = new Date();
    const incoming: Message = {
      id: `in${Date.now()}`,
      text: 'Hello — a new message just arrived.',
      sent: false,
      time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      dateKey: getDateKey(now),
    };

    const chatId = target.id;
    const opened = selectedChatId === chatId;

    setUnreadByChat((prev) => onIncomingMessage(prev, chatId, opened));

    if (chats.some((c) => c.id === chatId)) {
      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId
            ? { ...c, messages: [...c.messages, incoming], lastMessage: incoming.text, lastMessageTime: incoming.time }
            : c,
        ),
      );
    } else {
      setDraftChat((prev) => (prev && prev.id === chatId ? { ...prev, messages: [...prev.messages, incoming] } : prev));
    }

    return {
      chatId,
      opened,
      unreadTotal: Object.values(unreadByChat).reduce((sum, n) => sum + n, 0) + (opened ? 0 : 1),
    };
  }, [chats, draftChat, selectedChatId, unreadByChat]);

  // Register the deny-path VERIFY knob so a devtools call can fire it while the
  // screen is mounted (in-app unread is screen-local, unlike the push knob).
  useEffect(() => {
    simulateIncomingMessageHandle = simulateIncomingMessage;
    return () => {
      simulateIncomingMessageHandle = null;
    };
  }, [simulateIncomingMessage]);

  // PERM-2.13 re-detection (edge case): if the app returns to the foreground
  // after Contacts was granted in Settings, re-verify and transition the open
  // picker back to synced contacts without navigating away.
  useEffect(() => {
    if (!showContactPicker) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        Contacts.getPermissionsAsync()
          .then((perm) => {
            if (perm.granted ?? perm.status === 'granted') {
              loadContactsForPicker();
            }
          })
          .catch(() => {});
      }
    });
    return () => sub.remove();
  }, [showContactPicker, loadContactsForPicker]);

  // PERM-2.13 (foreground re-detection, Task 13): whenever the app resumes,
  // re-read the real OS state for Notifications — the OS is the source of
  // truth. If it was granted via Settings while the app was backgrounded, the
  // push token is (idempotently) registered so alerts fire on the next
  // background; if it is denied, the Chat List shows the Notifications-denied
  // banner. No native dialog ever opens from this listener, and there is no
  // navigation side-effect, so returning to the foreground can't loop.
  useEffect(() => {
    let mounted = true;

    const resyncNotifications = () => {
      checkNotificationsState()
        .then((state) => {
          if (!mounted) return;
          setNotificationsDenied(state === 'denied');
          if (state === 'granted') {
            registerPushOnGrant();
          }
        })
        .catch(() => {});
    };

    resyncNotifications();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') resyncNotifications();
    });

    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  const toggleSearch = () => {
    setShowSearch(!showSearch);
    if (showSearch) setSearchQuery('');
  };

  const handleBackFromChat = () => {
    setSelectedChatId(null);
    setDraftChat(null);
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 800);
  }, []);

  const filteredChats = chats.filter((c) =>
    c.contact.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const selectedChat =
    chats.find((c) => c.id === selectedChatId) ||
    (draftChat && draftChat.id === selectedChatId ? draftChat : null) ||
    null;

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.bg }]} edges={['top']}>
      <StatusBar barStyle={colors.statusBar as StatusBarStyle} backgroundColor={colors.bg} />

      <View style={s.content}>
        <Header colors={colors} onSearchPress={toggleSearch} onMenuPress={() => setShowMenu(true)} />

        {notificationsDenied && !selectedChat && (
          <View style={s.notifBannerContainer}>
            <PermissionBanner permissionId="notifications" />
          </View>
        )}

        {showSearch && (
          <View style={[s.searchContainer, { backgroundColor: colors.bg, borderBottomColor: colors.border }]}>
            <View style={[s.searchInputContainer, { backgroundColor: colors.searchBg, borderColor: colors.border }]}>
              <Ionicons name="search" size={18} color={colors.textDim} />
              <TextInput
                style={[s.searchInput, { color: colors.text }]}
                placeholder="Search chats..."
                placeholderTextColor={colors.textDim}
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoFocus
                returnKeyType="done"
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity onPress={() => setSearchQuery('')}>
                  <Ionicons name="close-circle" size={18} color={colors.textDim} />
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {filteredChats.length > 0 ? (
          <FlatList
            data={filteredChats}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <ChatItem
                chat={item}
                colors={colors}
                unread={unreadByChat[item.id] ?? 0}
                onPress={() => openChat(item.id)}
              />
            )}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={s.listContent}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={colors.accent}
                colors={[colors.accent]}
              />
            }
          />
        ) : (
          <EmptyState colors={colors} />
        )}

        <TouchableOpacity
          style={[s.fab, { backgroundColor: colors.accent }]}
          onPress={openContactPicker}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={28} color={colors.bg} />
        </TouchableOpacity>
      </View>

      {selectedChat && (
        <View style={StyleSheet.absoluteFillObject}>
          <ChatView
            chat={selectedChat}
            colors={colors}
            onBack={handleBackFromChat}
            setChatMessages={setChatMessages}
          />
        </View>
      )}

      <ContactPickerModal
        visible={showContactPicker}
        onClose={() => setShowContactPicker(false)}
        onSelectContact={selectContact}
        onManualChat={handleManualChat}
        loading={loadingContacts}
        contacts={contacts}
        permissionDenied={permissionDenied}
        onRequestPermission={loadContactsForPicker}
        onOpenSettings={() => Linking.openSettings()}
        colors={colors}
      />

      <Modal
        visible={showMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setShowMenu(false)}
      >
        <TouchableOpacity
          style={[s.menuOverlay, { backgroundColor: colors.overlay }]}
          activeOpacity={1}
          onPress={() => setShowMenu(false)}
        >
          <View style={[s.menuContainer, { backgroundColor: colors.bg2, borderColor: colors.border }]}>
            <TouchableOpacity style={s.menuItem} onPress={() => { setShowMenu(false); Alert.alert('New Group', 'Coming soon'); }}>
              <Ionicons name="people-outline" size={20} color={colors.text} />
              <Text style={[s.menuText, { color: colors.text }]}>New Group</Text>
            </TouchableOpacity>
            <View style={[s.menuDivider, { backgroundColor: colors.border }]} />
            <TouchableOpacity
              style={s.menuItem}
              onPress={() => { setShowMenu(false); router.push('/settings'); }}
            >
              <Ionicons name="settings-outline" size={20} color={colors.text} />
              <Text style={[s.menuText, { color: colors.text }]}>Settings</Text>
            </TouchableOpacity>
            <View style={[s.menuDivider, { backgroundColor: colors.border }]} />
            <TouchableOpacity
              style={[s.menuItem, s.menuItemDanger]}
              onPress={() => { setShowMenu(false); Alert.alert('Logged Out', 'You have been logged out.'); }}
            >
              <Ionicons name="log-out-outline" size={20} color={colors.danger} />
              <Text style={[s.menuText, { color: colors.danger }]}>Logout</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 8 : 12,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 26, fontFamily: FONTS.heading },
  headerSubtitle: { fontSize: 12, marginTop: 1, fontFamily: FONTS.body },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  headerIcon: { padding: 4 },

  searchContainer: { paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  notifBannerContainer: { paddingHorizontal: 20, paddingTop: 12 },
  searchInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 9 : 7,
    borderWidth: 1,
  },
  searchInput: { flex: 1, marginLeft: 8, fontSize: 15, fontFamily: FONTS.body },

  listContent: { paddingTop: 4, paddingBottom: 80 },

  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chatInfo: { flex: 1 },
  chatTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 },
  chatName: { fontSize: 16, fontWeight: '600', fontFamily: FONTS.bodyMedium, flex: 1 },
  chatTime: { fontSize: 11, fontFamily: FONTS.body, marginLeft: 8 },
  chatBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chatMessage: { flex: 1, fontSize: 14, fontFamily: FONTS.body, marginRight: 8 },

  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadText: { color: '#FFF', fontSize: 11, fontWeight: '700', fontFamily: FONTS.bodyMedium },

  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  avatarText: { fontWeight: '600', fontFamily: FONTS.bodyMedium },
  onlineDot: { position: 'absolute', bottom: 0, right: 0 },

  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, paddingBottom: 80 },
  emptyIconContainer: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    borderWidth: 1,
  },
  emptyTitle: { fontSize: 20, fontWeight: '600', marginBottom: 8, fontFamily: FONTS.heading },
  emptySubtitle: { fontSize: 14, textAlign: 'center', fontFamily: FONTS.body },

  fab: {
    position: 'absolute',
    right: 20,
    bottom: 28,
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 5,
  },

  modalContainer: { flex: 1 },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalBackButton: { padding: 4 },
  modalTitle: { fontSize: 17, fontWeight: '600', fontFamily: FONTS.bodyMedium },
  modalList: { paddingHorizontal: 16, paddingBottom: 20 },
  contactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  contactInfo: { flex: 1, marginLeft: 10 },
  contactName: { fontSize: 15, fontFamily: FONTS.bodyMedium },
  contactPhone: { fontSize: 13, fontFamily: FONTS.body, marginTop: 1 },
  modalEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  modalEmptyText: { fontSize: 15, marginTop: 10, fontFamily: FONTS.body, textAlign: 'center' },
  emptyButton: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, marginTop: 16 },
  emptyButtonText: { fontSize: 14, fontWeight: '600', fontFamily: FONTS.bodyMedium },

  modalDenied: { flex: 1, paddingHorizontal: 20, paddingTop: 20 },
  manualTitle: { fontSize: 17, fontWeight: '600', fontFamily: FONTS.bodyMedium, marginBottom: 6 },
  manualHint: { fontSize: 13, lineHeight: 19, fontFamily: FONTS.body, marginBottom: 16 },
  manualInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    gap: 10,
    marginBottom: 16,
  },
  manualInput: { flex: 1, fontSize: 16, fontFamily: FONTS.body },
  manualError: { fontSize: 13, fontFamily: FONTS.body, marginBottom: 14, marginTop: -8 },
  manualStartButton: {
    minHeight: 52,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  manualStartText: { fontSize: 14, fontWeight: '600', letterSpacing: 1.5, fontFamily: FONTS.bodyMedium },

  chatView: { flex: 1 },
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingTop: Platform.OS === 'ios' ? 8 : 12,
  },
  backButton: { padding: 4, marginRight: 4 },
  chatHeaderInfo: { flex: 1, marginLeft: 8 },
  chatHeaderName: { fontSize: 16, fontWeight: '600', fontFamily: FONTS.bodyMedium },
  chatHeaderStatus: { fontSize: 12, fontFamily: FONTS.body },
  chatHeaderIcon: { padding: 4 },

  chatBody: { flex: 1, justifyContent: 'flex-end' },
  messagesList: { paddingHorizontal: 14, paddingVertical: 8, flexGrow: 1, justifyContent: 'flex-end' },

  messageRow: { marginBottom: 6 },
  messageRowSent: { alignItems: 'flex-end' },
  messageRowReceived: { alignItems: 'flex-start' },

  messageBubble: { maxWidth: '78%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  sentBubble: { borderBottomRightRadius: 4 },
  receivedBubble: { borderBottomLeftRadius: 4 },

  messageText: { fontSize: 15.5, fontFamily: FONTS.body, lineHeight: 21 },
  messageImage: {
    width: 200,
    height: 200,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 4,
  },
  voiceNoteRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2 },
  voiceNoteText: { fontSize: 15.5, fontFamily: FONTS.body, fontVariant: ['tabular-nums'] },
  messageMeta: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', marginTop: 2 },
  messageTime: { fontSize: 10.5, fontFamily: FONTS.body },

  dateSeparatorContainer: { alignItems: 'center', marginVertical: 12 },
  dateSeparatorPill: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
  },
  dateSeparatorText: { fontSize: 12, fontFamily: FONTS.bodyMedium },

  typingContainer: { marginBottom: 8, alignItems: 'flex-start' },
  typingDots: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 10, gap: 4 },
  typingDot: { width: 7, height: 7, borderRadius: 4 },

  scrollDownFab: {
    position: 'absolute',
    right: 16,
    bottom: 80,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
  },

  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 10,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  attachButton: { marginRight: 6, paddingBottom: 4 },
  inputFieldContainer: {
    flex: 1,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 14,
    minHeight: 40,
    justifyContent: 'center',
  },
  inputField: { fontSize: 15, fontFamily: FONTS.body, paddingVertical: 8, maxHeight: 100 },

  recordingState: {
    flex: 1,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 14,
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
  },
  recordingDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  recordingText: { fontSize: 14, fontFamily: FONTS.bodyMedium, flex: 1 },
  recordingTimer: { fontSize: 14, fontFamily: FONTS.body, fontVariant: ['tabular-nums'] },
  recordingError: { fontSize: 11, fontFamily: FONTS.body, marginTop: 4 },

  sendButton: {
    marginLeft: 8,
    borderRadius: 20,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },

  menuOverlay: { flex: 1, justifyContent: 'flex-start', paddingTop: Platform.OS === 'ios' ? 70 : 50, alignItems: 'flex-end', paddingRight: 16 },
  menuContainer: { borderRadius: 12, paddingVertical: 6, minWidth: 180, borderWidth: StyleSheet.hairlineWidth },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  menuItemDanger: {},
  menuText: { fontSize: 15, fontFamily: FONTS.body },
  menuDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: 12 },
});
