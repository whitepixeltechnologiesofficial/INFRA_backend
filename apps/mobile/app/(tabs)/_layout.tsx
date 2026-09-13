// app/(tabs)/_layout.tsx
//
// AUTH-GATE — (tabs) is the authenticated messaging space. A direct deep link
// or refresh must NOT reach it unless BOTH conditions hold:
//   1. durable legal acceptance (`requireLegalAccepted`, the same gate used by
//      every protected onboarding screen), and
//   2. a created session (userId stored by the session hook's OTP / handoff
//      flows — the same SecureStore key `useSession` reads as its identity).
// Failing either condition bounces to the correct onboarding state. Entry
// screens never navigate back to (tabs) on mount, so there is no redirect
// loop. This is a single centralized guard at the layout level — no per-screen
// scatter needed.
import { Tabs, router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '@/providers/ThemeProvider';
import { requireLegalAccepted } from '@/lib/legal-acceptance';
import * as SecureStore from 'expo-secure-store';

const SESSION_USER_KEY = 'userId';

export default function TabLayout() {
  const { colors } = useThemeContext();
  const [gateChecked, setGateChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const legalAccepted = await requireLegalAccepted();
        if (!legalAccepted) {
          if (!cancelled) router.replace('/legal-acceptance');
          return;
        }
        const userId = await SecureStore.getItemAsync(SESSION_USER_KEY);
        if (!userId) {
          if (!cancelled) router.replace('/phone-entry');
          return;
        }
        if (!cancelled) setGateChecked(true);
      } catch {
        // Storage failure — block closed by default rather than risk exposure.
        if (!cancelled) router.replace('/legal-acceptance');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!gateChecked) return null;

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
