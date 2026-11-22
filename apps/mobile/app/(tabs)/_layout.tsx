import { requireLegalAccepted } from '@/lib/legal-acceptance';
import { useThemeContext } from '@/providers/ThemeProvider';
import { Ionicons } from '@expo/vector-icons';
import { Tabs, router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import React, { useEffect, useState } from 'react';

const SESSION_USER_KEY = 'userId';

export default function TabLayout() {
  const { colors } = useThemeContext();
  const [gateChecked, setGateChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Legal acceptance is mandatory and durable — a navigation-only
        // acknowledgement (or a restored stack/deep link) must not bypass it.
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
        if (!cancelled) router.replace('/legal-acceptance');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!gateChecked) {
    return null;
  }

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