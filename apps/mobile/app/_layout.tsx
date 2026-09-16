import { DarkTheme, DefaultTheme, ThemeProvider as NavThemeProvider } from '@react-navigation/native';
import { Href, Stack, usePathname, useRouter } from 'expo-router';
import { addEventListener as addLinkingEventListener, getInitialURL } from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { useCallback, useEffect, useRef } from 'react';
import { useFonts } from 'expo-font';
import { Lato_400Regular, Lato_400Regular_Italic, Lato_700Bold, Lato_900Black } from '@expo-google-fonts/lato';
import { ThemeProvider, useThemeContext } from '@/providers/ThemeProvider';
import { SessionProvider } from '@/providers/SessionProvider';
import { configurePushNotifications } from '@/lib/push';
import { OnboardingGuardProvider, useOnboardingGuard } from '@/providers/OnboardingGuardProvider';
import {
  decideDeepLinkGate,
  decideGateForRoute,
  normalizeRouteKey,
  parseDeepLink,
} from '@/lib/deep-link-guard';

configurePushNotifications();

export const unstable_settings = {
  anchor: 'index',
};

// DeepLinkGuard — central navigation security boundary (resolve-before-render).
//
// A deep link can supply ROUTING CONTEXT ONLY. No URL parameter — in
// particular `phoneNumber` — is ever treated as proof of identity. This guard:
//   1. Steps every launch URL (cold start via Linking.getInitialURL) and every
//      subsequent deep link (Linking 'url' event) through decideDeepLinkGate.
//   2. Steps the resolved pathname through decideGateForRoute as belt-and-
//      suspenders, so a protected route can never stay focused while the
//      SecureStore snapshot does not allow it.
// The decision uses ONLY the locally-resolved SecureStore snapshot (legal
// acceptance + session). url phone numbers never create a session, never mark
// an OTP verified, and never reach Chat List / Profile Setup / Device Handoff.
// On a fresh/unauthenticated state every protected deep link bounces to
// /legal-acceptance and stops there until the user explicitly accepts.
function DeepLinkGuard() {
  const router = useRouter();
  const pathname = usePathname();
  const { snapshot } = useOnboardingGuard();

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const handledRef = useRef<Set<string>>(new Set());

  const redirectIfBlocked = useCallback(
    (href: string | null | undefined) => {
      if (!href) return;
      if (handledRef.current.has(href)) return;
      handledRef.current.add(href);
      const intent = parseDeepLink(href);
      const gate = intent ? decideDeepLinkGate(intent, snapshotRef.current) : null;
      if (gate) {
        router.replace(gate as Href);
      }
    },
    [router],
  );

  // Cold-start deep link: read the launch URL once before the app reacts to it.
  useEffect(() => {
    let cancelled = false;
    getInitialURL()
      .then((initial) => {
        if (!cancelled) redirectIfBlocked(initial);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [redirectIfBlocked]);

  // Subsequent deep links while the app is open (e.g. Expo Go "Open from
  // Clipboard", a second am start VIEW intent). Same gate as cold start.
  useEffect(() => {
    const sub = addLinkingEventListener('url', (event) => redirectIfBlocked(event.url));
    return () => sub.remove();
  }, [redirectIfBlocked]);

  // Resolved-pathname gate: if a protected route is ever focused while the
  // snapshot blocks it, bounce to the correct gate. Never renders through it.
  useEffect(() => {
    const gate = decideGateForRoute(normalizeRouteKey(pathname), snapshot);
    if (gate) router.replace(gate as Href);
  }, [pathname, snapshot, router]);

  return null;
}

function RootLayoutInner() {
  const { colorScheme, colors } = useThemeContext();
  const { snapshot } = useOnboardingGuard();

  const [fontsLoaded, fontError] = useFonts({
    'Lato-Black': Lato_900Black,
    'Lato-Italic': Lato_400Regular_Italic,
    'Lato-Regular': Lato_400Regular,
    'Lato-Bold': Lato_700Bold,
  });

  if (!fontsLoaded && !fontError) {
    return null;
  }

  const navTheme = colorScheme === 'dark'
    ? { ...DarkTheme, colors: { ...DarkTheme.colors, background: colors.bg, card: colors.tabBar, text: colors.text, border: colors.tabBarBorder, primary: colors.accent } }
    : { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: colors.bg, card: colors.tabBar, text: colors.text, border: colors.tabBarBorder, primary: colors.accent } };

  return (
    <NavThemeProvider value={navTheme}>
      <SessionProvider>
        <DeepLinkGuard />
        <Stack
          screenOptions={{
            headerShown: false,
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />

          <Stack.Screen name="legal-acceptance" options={{ headerShown: false }} />

          <Stack.Protected guard={snapshot.legalAccepted}>
            <Stack.Screen name="phone-entry" options={{ headerShown: false }} />
            <Stack.Screen name="otp-entry" options={{ headerShown: false }} />
          </Stack.Protected>

          <Stack.Protected guard={snapshot.hasSession}>
            <Stack.Screen name="profile-setup" options={{ headerShown: false }} />
            <Stack.Screen name="permission-intro" options={{ headerShown: false }} />
            <Stack.Screen name="notifications-info" options={{ headerShown: false }} />
            <Stack.Screen name="permission-info" options={{ headerShown: false }} />
            <Stack.Screen name="device-handoff" options={{ headerShown: false }} />
            <Stack.Screen name="settings" options={{ headerShown: false }} />
            <Stack.Screen name="scan" options={{ headerShown: false }} />
            <Stack.Screen name="blocked-contacts" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          </Stack.Protected>
        </Stack>
        <StatusBar style={colors.statusBar} />
      </SessionProvider>
    </NavThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <OnboardingGuardProvider>
        <RootLayoutInner />
      </OnboardingGuardProvider>
    </ThemeProvider>
  );
}
