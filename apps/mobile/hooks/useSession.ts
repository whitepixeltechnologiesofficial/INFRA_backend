// hooks/useSession.ts
// §7.3 — Resume-time session validation + session management.
//
// On every foreground transition, the very first network call is
// checkSessionValidity against /session/check. If the backend says
// revokedAt is set (another device logged in while we were offline),
// we silently log out — same as receiving a force_logout push.
//
// ONB-1.7 — while the app is ACTIVE, session validity is also verified on a
// bounded ~30s polling loop so a connected old device is cut off promptly when
// a new device logs in (no warning UI, silent). Polling pauses while the app is
// backgrounded/inactive and resumes on foreground; timers and listeners are
// cleaned up on unmount, and logout navigation is de-duplicated.
//
// SECURITY: userId is never sent in request bodies — the backend
// derives it from the verified JWT access token.

import { useState, useEffect, useRef } from 'react';
import { onboardingApi } from '@/api/onboardingApi';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { Platform, AppState, AppStateStatus } from 'react-native';
import { getOrCreateDeviceId } from '@/lib/device-identity';
import { SessionPoller } from '@/lib/session-policy';

const POLL_INTERVAL_MS = 30_000;

const getDeviceName = (): string => {
  const platform = Platform.OS === 'ios' ? 'iPhone' : 'Android';
  return `${platform} ${Platform.OS === 'ios' ? '' : 'Device'}`;
};

export const useSession = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [displayPhone, setDisplayPhone] = useState<string | null>(null);
  const [sessionValid, setSessionValid] = useState(true);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);

  const appState = useRef(AppState.currentState);
  const loggedOutRef = useRef(false);
  const pollerRef = useRef<SessionPoller | null>(null);

  // ── ONB-1.7: bounded background-aware polling. Only runs while the app is
  // ACTIVE (foreground) AND a session exists. The SessionPoller is a singleton:
  // at most one interval, paused on background, resumed on foreground, torn
  // down on unmount / state change — no duplicate timers, no leaked intervals.
  useEffect(() => {
    if (!userId || !deviceId) return;

    const validate = () => {
      validateSession(deviceId);
    };

    const poller = new SessionPoller(validate, POLL_INTERVAL_MS);
    poller.start();
    pollerRef.current = poller;

    return () => {
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [userId, deviceId, isAuthenticated]);

  // ── §7.3: Foreground transition + active-state tracking ──
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const wasBackground = appState.current.match(/background/);
      appState.current = next;
      const isActive = next === 'active';

      pollerRef.current?.setActive(isActive);

      if (wasBackground && isActive) {
        checkSession();
      }
    });

    return () => sub.remove();
  }, [userId, deviceId]);

  // Initialize session on mount
  useEffect(() => {
    initializeSession();
  }, []);

  const initializeSession = async () => {
    loggedOutRef.current = false;
    try {
      const storedUserId = await SecureStore.getItemAsync('userId');
      const storedDeviceId = await SecureStore.getItemAsync('deviceId');
      const storedAccessToken = await SecureStore.getItemAsync('accessToken');

      if (storedUserId && storedDeviceId && storedAccessToken) {
        setUserId(storedUserId);
        setDeviceId(storedDeviceId);
        setDisplayPhone(await SecureStore.getItemAsync('displayPhone'));
        await validateSession(storedDeviceId);
      } else if (storedUserId || storedDeviceId) {
        await SecureStore.deleteItemAsync('userId');
        await SecureStore.deleteItemAsync('deviceId');
        await SecureStore.deleteItemAsync('accessToken');
        await SecureStore.deleteItemAsync('refreshToken');
      }
    } catch (error) {
      console.error('Failed to initialize session:', error);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * §7.3 — Core validation logic. Returns true if session is alive.
   * Backend derives userId from JWT — only deviceId is sent.
   */
  const validateSession = async (did: string): Promise<boolean> => {
    try {
      const result = await onboardingApi.checkSessionValidity({
        deviceId: did,
      });

      if (!result.isValid) {
        await silentLogout();
        return false;
      }

      setSessionValid(true);
      setSessionMessage(null);
      return true;
    } catch (error) {
      // Network failure / backend unreachable — do NOT cut a live user off
      // just because a check request failed. The next poll / foreground
      // resume retries; a revoked session is only acted on when the backend
      // (the source of truth) actually reports it.
      console.warn('Session check failed (network?):', error);
      return true;
    }
  };

  /**
   * Silent logout — clear all local state, navigate to phone-entry.
   * NO warning, NO alert, NO toast: the cutoff must be silent (ONB-1.7).
   * De-duplicated so concurrent poll + foreground-resume checks don't navigate
   * twice.
   */
  const silentLogout = async () => {
    if (loggedOutRef.current) return;
    loggedOutRef.current = true;

    setSessionValid(false);
    await SecureStore.deleteItemAsync('userId');
    await SecureStore.deleteItemAsync('deviceId');
    await SecureStore.deleteItemAsync('accessToken');
    await SecureStore.deleteItemAsync('refreshToken');
    await SecureStore.deleteItemAsync('displayPhone');
    setIsAuthenticated(false);
    setUserId(null);
    setDeviceId(null);
    setDisplayPhone(null);
    router.replace('/phone-entry');
  };

  const checkSession = async () => {
    if (!deviceId) return;
    await validateSession(deviceId);
  };

  /**
   * ONB-1.7: Create a new session for the current device.
   * Uses the refresh token from SecureStore to authenticate the handoff.
   * Uses the STABLE persisted device identity so a re-login on the same
   * physical device does not mint a brand-new identity.
   */
  const createSession = async (newUserId: string) => {
    try {
      const newDeviceId = await getOrCreateDeviceId();
      const deviceName = getDeviceName();
      const platform = Platform.OS === 'ios' ? 'ios' : 'android';

      // Get the refresh token — the handoff endpoint validates it server-side
      const refreshToken = await SecureStore.getItemAsync('refreshToken');

      const result = await onboardingApi.handleLoginHandoff({
        refreshToken: refreshToken ?? '',
        deviceInfo: {
          deviceId: newDeviceId,
          deviceName,
          platform,
        },
      });

      loggedOutRef.current = false;
      await Promise.all([
        SecureStore.setItemAsync('userId', newUserId),
        SecureStore.setItemAsync('deviceId', newDeviceId),
        SecureStore.setItemAsync('accessToken', result.accessToken),
        SecureStore.setItemAsync('refreshToken', result.refreshToken),
      ]);

      setUserId(newUserId);
      setDeviceId(newDeviceId);
      setIsAuthenticated(true);
      setSessionValid(true);
      setSessionMessage(result.message);

      return result.message;
    } catch (error) {
      console.error('Failed to create session:', error);
      throw error;
    }
  };

  const logout = async () => {
    loggedOutRef.current = true;
    await SecureStore.deleteItemAsync('userId');
    await SecureStore.deleteItemAsync('deviceId');
    await SecureStore.deleteItemAsync('accessToken');
    await SecureStore.deleteItemAsync('refreshToken');
    await SecureStore.deleteItemAsync('displayPhone');
    setIsAuthenticated(false);
    setUserId(null);
    setDeviceId(null);
    setDisplayPhone(null);
    setSessionValid(false);
    router.replace('/phone-entry');
  };

  return {
    isLoading,
    isAuthenticated,
    userId,
    deviceId,
    displayPhone,
    sessionValid,
    sessionMessage,
    createSession,
    checkSession,
    logout,
    silentLogout,
  };
};
