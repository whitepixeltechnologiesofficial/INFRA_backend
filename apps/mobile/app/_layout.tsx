import { DarkTheme, DefaultTheme, ThemeProvider as NavThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { useEffect } from 'react';
import { useFonts } from 'expo-font';
import { Lato_400Regular, Lato_400Regular_Italic, Lato_700Bold, Lato_900Black } from '@expo-google-fonts/lato';
import { ThemeProvider, useThemeContext } from '@/providers/ThemeProvider';
import { SessionProvider, useSessionContext } from '@/providers/SessionProvider';

// ONB-1.1 — the ONLY screens you may open without being logged in.
const PUBLIC_SCREENS = ['index', 'splash', 'legal-acceptance', 'phone-entry', 'otp-entry'];

// Door guard: if you are not logged in and you are on any other screen,
// go back to the splash screen. Works for taps, back buttons AND deep links.
function AuthGate() {
  const { isLoading, isAuthenticated } = useSessionContext();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;                     // wait until we know
    const first = segments[0] ?? 'index';      // which screen are we on?
    const isPublic = PUBLIC_SCREENS.includes(first);
    if (!isAuthenticated && !isPublic) {
      router.replace('/');                     // back to splash
    }
  }, [isLoading, isAuthenticated, segments, router]);

  return null;
}

function RootLayoutInner() {
  const { colorScheme, colors } = useThemeContext();

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
        <AuthGate />
        <Stack
          screenOptions={{
            headerShown: false,
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="phone-entry" options={{ headerShown: false }} />
          <Stack.Screen name="legal-acceptance" options={{ headerShown: false }} />
          <Stack.Screen name="otp-entry" options={{ headerShown: false }} />
          <Stack.Screen name="profile-setup" options={{ headerShown: false }} />
          <Stack.Screen name="settings" options={{ headerShown: false }} />
          <Stack.Screen name="scan" options={{ headerShown: false, animation: 'slide_from_bottom' }} />
        </Stack>
        <StatusBar style={colors.statusBar} />
      </SessionProvider>
    </NavThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <RootLayoutInner />
    </ThemeProvider>
  );
}
