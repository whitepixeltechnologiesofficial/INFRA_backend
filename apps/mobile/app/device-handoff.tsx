// app/device-handoff.tsx
// ONB-1.7 — New-device login handoff
// Per PRD Scenarios 5.1–5.4: Successful verification on new device force-logs-out
// old phone + Web silently. Confirmation shown only on new device.
//
// Reached from the real login flow: `otp-entry` routes here when the backend
// reports a login that cut off previous devices (`previousDevicesLoggedOut > 0`).
// In that case the session is ALREADY established by OTP verify — this screen
// only presents the confirmation and continues into the app. The `fromOtp=1`
// param distinguishes that path from a standalone handoff (e.g. a refresh-token
// device add), where `createSession` performs the session takeover.
//
// SECURITY: this screen is authenticated-only. It uses the centralized route
// guard (fresh/unauthenticated -> /legal-acceptance or /phone-entry, redirect
// discards query params), and ALL identity comes from the OTP-verified session
// snapshot — never from URL params. Nothing identity-bearing is written to
// SecureStore from this screen (displayPhone is persisted by otp-entry).

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSession } from '@/hooks/useSession';
import { useRouteGuard } from '@/hooks/useRouteGuard';

export default function DeviceHandoffScreen() {
  const { fromOtp } = useLocalSearchParams<{ fromOtp?: string }>();
  const fromOtpFlag = fromOtp === '1';
  // ROUTE-GATE — authenticated-only screen. Blocks direct deep-links before
  // anything renders and supplies the VERIFIED session identity.
  const snapshot = useRouteGuard('device-handoff');
  const [isLoading, setIsLoading] = useState(true);
  const { createSession } = useSession();
  const createSessionRef = useRef(createSession);
  createSessionRef.current = createSession;

  useEffect(() => {
    // Wait for the guard to resolve — never run handoff logic against params.
    if (!snapshot) return;
    (async () => {
      try {
        if (!fromOtpFlag) {
          // Standalone / refresh-token handoff: the session is created HERE via
          // the handoff endpoint using the VERIFIED userId (from SecureStore,
          // not URL params). (The OTP path skips this — OTP verify already
          // established the session and wrote the identifiers to SecureStore.)
          if (snapshot.userId) {
            await createSessionRef.current(snapshot.userId);
          }
        }
        setIsLoading(false);
      } catch {
        setIsLoading(false);
      }
    })();
  }, [fromOtpFlag, snapshot]);

  const handleContinue = () => {
    router.replace('/(tabs)');
  };

  if (!snapshot) return null;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <View style={styles.seal}>
            <View style={styles.sealDot} />
          </View>
        </View>

        <Text style={styles.title}>Logged In!</Text>
        <Text style={styles.subtitle}>
          This is your new device. Your other devices have been logged out.
        </Text>

        {isLoading ? (
          <ActivityIndicator color="#3FC6B8" size="large" style={styles.loader} />
        ) : (
          <TouchableOpacity style={styles.continueButton} onPress={handleContinue}>
            <Text style={styles.continueButtonText}>Continue</Text>
          </TouchableOpacity>
        )}

        <Text style={styles.note}>
          Old devices were logged out silently — no warning was shown there.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#15171C',
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  iconContainer: {
    marginBottom: 24,
  },
  seal: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: '#3FC6B8',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  sealDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#3FC6B8',
  },
  title: {
    fontWeight: '700',
    fontSize: 28,
    color: '#F3F3F4',
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    color: '#9AA0AC',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
  },
  loader: {
    marginVertical: 8,
  },
  continueButton: {
    backgroundColor: '#0F9C90',
    borderRadius: 14,
    height: 56,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  continueButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  note: {
    fontSize: 11,
    color: '#6B7280',
    textAlign: 'center',
    marginTop: 16,
    lineHeight: 16,
  },
});