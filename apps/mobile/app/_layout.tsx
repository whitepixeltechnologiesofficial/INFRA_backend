// app/_layout.tsx
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { useFonts } from 'expo-font';
import { Fraunces_800ExtraBold, Fraunces_400Regular_Italic } from '@expo-google-fonts/fraunces';
import { SpaceGrotesk_400Regular, SpaceGrotesk_500Medium } from '@expo-google-fonts/space-grotesk';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { SessionProvider } from '@/providers/SessionProvider';

export default function RootLayout() {
  const colorScheme = useColorScheme();

  const [fontsLoaded, fontError] = useFonts({
    'Fraunces-Black': Fraunces_800ExtraBold,
    'Fraunces-Italic': Fraunces_400Regular_Italic,
    'SpaceGrotesk-Regular': SpaceGrotesk_400Regular,
    'SpaceGrotesk-Medium': SpaceGrotesk_500Medium,
  });

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <SessionProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            animation: 'slide_from_right',
          }}
        >
          {/* index.tsx = root splash screen (tap → legal-acceptance → phone-entry) */}
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="phone-entry" options={{ headerShown: false }} />
          <Stack.Screen name="legal-acceptance" options={{ headerShown: false }} />
          <Stack.Screen name="otp-entry" options={{ headerShown: false }} />
          <Stack.Screen name="profile-setup" options={{ headerShown: false }} />
        </Stack>
        <StatusBar style="auto" />
      </SessionProvider>
    </ThemeProvider>
  );
}
