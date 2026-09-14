// providers/OnboardingGuardProvider.tsx
//
// ONB-1.1 — Resolve-before-render guard. The SecureStore snapshot is resolved
// ONCE at mount before any protected screen can render. Screens feed the
// provider state synchronously (markLegalAccepted / markSession) BEFORE
// navigating so the Stack.Protected guard flips in the same render cycle.
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { OnboardingSnapshot, resolveSnapshot } from '@/lib/onboarding-guard';

interface OnboardingGuardContextType {
  snapshot: OnboardingSnapshot;
  markLegalAccepted: () => void;
  markSession: (userId: string, deviceId: string) => void;
  clearSession: () => void;
}

const OnboardingGuardContext = createContext<OnboardingGuardContextType | undefined>(undefined);

const EMPTY_SNAPSHOT: OnboardingSnapshot = {
  legalAccepted: false,
  userId: null,
  deviceId: null,
  hasSession: false,
};

export function OnboardingGuardProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot>(EMPTY_SNAPSHOT);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    resolveSnapshot(SecureStore).then((s) => {
      setSnapshot(s);
      setResolved(true);
    });
  }, []);

  const markLegalAccepted = useCallback(() => {
    setSnapshot((prev) => ({ ...prev, legalAccepted: true }));
  }, []);

  const markSession = useCallback((userId: string, deviceId: string) => {
    setSnapshot((prev) => ({ ...prev, userId, deviceId, hasSession: true }));
  }, []);

  const clearSession = useCallback(() => {
    setSnapshot((prev) => ({
      ...prev,
      userId: null,
      deviceId: null,
      hasSession: false,
    }));
  }, []);

  if (!resolved) return null;

  return (
    <OnboardingGuardContext.Provider
      value={{ snapshot, markLegalAccepted, markSession, clearSession }}
    >
      {children}
    </OnboardingGuardContext.Provider>
  );
}

export function useOnboardingGuard() {
  const context = useContext(OnboardingGuardContext);
  if (!context) {
    throw new Error('useOnboardingGuard must be used within OnboardingGuardProvider');
  }
  return context;
}
