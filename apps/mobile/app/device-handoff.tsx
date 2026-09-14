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
// ONB-1.1 — Provenance: userId and displayPhone are ALWAYS read from SecureStore
// (set by otp-entry or a prior login). URL params are NEVER trusted for
// identifiers — this closes the fabricated-deep-link bypass.

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
import { requireLegalAccepted } from '@/lib/legal-acceptance';
import { STORE_KEYS } from '@/lib/onboarding-guard';
import { useOnboardingGuard } from '@/providers/OnboardingGuardProvider';
import * as SecureStore from 'expo-secure-store';

export default function DeviceHandoffScreen() {
  const params = useLocalSearchParams<{ fromOtp?: string }>();
  const fromOtp = params.fromOtp === '1';
  const [isLoading, setIsLoading] = useState(true);
  const { createSession } = useSession();
  const createSessionRef = useRef(createSession);
  createSessionRef.current = createSession;
  const { markSession } = useOnboardingGuard();

  useEffect(() => {
    const performHandoff = async () => {
      try {
        const legalAccepted = await requireLegalAccepted();
        if (!legalAccepted) {
          router.replace('/legal-acceptance');
          return;
        }

        const storedUserId = await SecureStore.getItemAsync(STORE_KEYS.USER_ID);
        if (!storedUserId) {
          router.replace('/phone-entry');
          return;
        }

        if (!fromOtp) {
          await createSessionRef.current(storedUserId);
        }

        const storedDeviceId = await SecureStore.getItemAsync(STORE_KEYS.DEVICE_ID);
        if (storedUserId && storedDeviceId) {
          markSession(storedUserId, storedDeviceId);
        }

        setIsLoading(false);
      } catch {
        setIsLoading(false);
      }
    };
    performHandoff();
  }, [fromOtp, markSession]);

  const handleContinue = () => {
    router.replace('/(tabs)');
  };

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