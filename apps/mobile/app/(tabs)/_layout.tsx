// app/(tabs)/_layout.tsx
//
// AUTH-GATE — (tabs) is the authenticated messaging space. A direct deep link
// or refresh must NOT reach it unless BOTH conditions hold:
//   1. durable legal acceptance, and
//   2. a created session (userId + accessToken stored by the OTP / handoff
//      flows — the same SecureStore keys `useSession` reads as its identity).
// The shared `useRouteGuard` reads both values atomically and blocks the
// layout from rendering until the decision resolves; query params are never
// forwarded on redirect.
import { Tabs } from 'expo-router';
import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '@/providers/ThemeProvider';
import { useRouteGuard } from '@/hooks/useRouteGuard';

export default function TabLayout() {
  const { colors } = useThemeContext();
  // ROUTE-GATE — (tabs) is authenticated-only. Shared guard reads legal
  // acceptance + session atomically; render nothing until allowed; redirect
  // discards every query param.
  const snapshot = useRouteGuard('(tabs)');

  if (!snapshot) return null;

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