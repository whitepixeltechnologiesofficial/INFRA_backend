import { Tabs, router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '@/providers/ThemeProvider';
import { permissionSequence } from '@/lib/permission-flow';
import { isSequencePending } from '@/lib/permission-sequence';

export default function TabLayout() {
  const { colors } = useThemeContext();
  const [ready, setReady] = useState(false);

  // PERM-2.1: while the explainer / OS sequence is still owed, the Chat List
  // is not reachable — every route into it is sent back to the explainer.
  useEffect(() => {
    let cancelled = false;
    permissionSequence.load().then((progress) => {
      if (cancelled) return;
      if (isSequencePending(progress)) router.replace('/permission-info');
      else setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) return null;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.tabBar,
          borderTopColor: colors.tabBarBorder,
        },
        tabBarInactiveTintColor: colors.textMuted,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Chats',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubble-ellipses" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
