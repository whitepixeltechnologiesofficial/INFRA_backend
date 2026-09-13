// hooks/useForceLogout.ts
// §7.3 — Silent logout listener (ONB-1.7).
//
// Connects to socket.io once the user has a valid session (userId + deviceId
// in SecureStore). On receiving `force_logout` from the server (pushed after
// a handoff transaction commits), silently cuts the session via the SAME
// silentLogout path the session-check uses (clears local state + SecureStore,
// navigates to phone-entry, no warning UI). No alert is ever shown — the push
// IS the disconnect signal.
//
// SECURITY: Passes JWT access token in handshake auth so the server can
// verify the connection belongs to a legitimate session.
//
// The socket is only opened in real-backend mode (EXPO_PUBLIC_USE_MOCK=false);
// the in-memory mock has no shared state and no socket server.

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { router } from 'expo-router';
import { getBackendUrl } from '@/api/backendClient';

// Backend is the shared-state path for two-physical-device testing: both
// devices must point at the SAME backend URL (LAN IP of the dev machine).
const BACKEND_URL = getBackendUrl() || process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:4000';

// Mock mode: when enabled (default), skip the real socket.io connection entirely.
// The backend is disabled for now — no live force_logout pushes are expected.
const USE_MOCK = process.env.EXPO_PUBLIC_USE_MOCK !== 'false';

type ForceLogoutHandler = () => Promise<void> | void;

export function useForceLogout(
  userId: string | null,
  deviceId: string | null,
  onForceLogout?: ForceLogoutHandler,
) {
  const socketRef = useRef<Socket | null>(null);
  const handlerRef = useRef<ForceLogoutHandler | undefined>(onForceLogout);
  handlerRef.current = onForceLogout;

  useEffect(() => {
    // In-memory mock has no socket server and no shared state — do not open a
    // real websocket. Genuine force_logout requires the real backend.
    if (USE_MOCK) return;

    if (!userId || !deviceId) return;

    let cancelled = false;

    const connect = async () => {
      // Lazy require so headless Node harnesses importing this module don't
      // pull expo-secure-store.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const SecureStore = require('expo-secure-store') as {
        getItemAsync(key: string): Promise<string | null>;
      };
      const accessToken = await SecureStore.getItemAsync('accessToken');

      const socket = io(`${BACKEND_URL}/realtime`, {
        transports: ['websocket', 'polling'],
        auth: { userId, deviceId, token: accessToken },
      });

      if (cancelled) {
        socket.disconnect();
        return;
      }

      socketRef.current = socket;

      // §7.3 — force_logout received: old device was superseded. Reuse the
      // shared silentLogout for a consistent, de-duplicated, warning-free cutoff.
      socket.on('force_logout', async () => {
        if (handlerRef.current) {
          await handlerRef.current();
        } else {
          // Fallback if no handler wired (should not happen via SessionProvider).
          const SecureStore2 = require('expo-secure-store') as {
            deleteItemAsync(key: string): Promise<void>;
          };
          await SecureStore2.deleteItemAsync('userId');
          await SecureStore2.deleteItemAsync('deviceId');
          await SecureStore2.deleteItemAsync('accessToken');
          await SecureStore2.deleteItemAsync('refreshToken');

          router.replace('/phone-entry');
        }
      });

      socket.on('connect_error', (err) => {
        console.warn('Socket connection error:', err.message);
      });
    };

    connect();

    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [userId, deviceId]);
}