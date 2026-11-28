// hooks/useForceLogout.ts
// §7.3 — Force logout listener (ONB-1.7).
//
// Connects to socket.io once the user has a valid session (userId + deviceId
// in SecureStore). On receiving `force_logout` from the server (pushed after
// a handoff transaction commits), clears all local session state, navigates
// to phone-entry, and explains why.
//
// SECURITY: Passes JWT access token in handshake auth so the server can
// verify the connection belongs to a legitimate session.

import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { io, type Socket } from 'socket.io-client';
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';
import { FORCE_LOGOUT_ALERT } from '@/lib/session-alerts';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? 'http://localhost:4000';

export function useForceLogout(userId: string | null, deviceId: string | null) {
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!userId || !deviceId) return;

    let cancelled = false;

    const connect = async () => {
      const accessToken = await SecureStore.getItemAsync('accessToken');

      // The server attaches Socket.IO to the "/realtime" HTTP path (see
      // apps/backend/src/app.ts). The default namespace is used, so the path
      // must be passed as an option — not appended to the URL, which would
      // target a non-existent namespace.
      const socket = io(BACKEND_URL, {
        path: '/realtime',
        transports: ['websocket', 'polling'],
        auth: { userId, deviceId, token: accessToken },
      });

      if (cancelled) {
        socket.disconnect();
        return;
      }

      socketRef.current = socket;

      // §7.3 — force_logout received: old device was superseded.
      socket.on('force_logout', async () => {
        // This socket speaks for the identity captured in `deviceId`. If the
        // store now holds a different device, this device re-logged in after
        // the push was queued — honouring it would wipe the session the user
        // just created (self-inflicted logout on the same phone).
        const currentDeviceId = await SecureStore.getItemAsync('deviceId');
        if (currentDeviceId !== deviceId) return;

        await SecureStore.deleteItemAsync('userId');
        await SecureStore.deleteItemAsync('deviceId');
        await SecureStore.deleteItemAsync('accessToken');
        await SecureStore.deleteItemAsync('refreshToken');

        router.replace('/phone-entry');
        Alert.alert(FORCE_LOGOUT_ALERT.title, FORCE_LOGOUT_ALERT.message);
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