// api/pushApi.ts
//
// PERM-2.5 — binds this device's Expo push token on the backend
// (apps/backend/src/routes/push.ts). The device is taken from the JWT.

import * as SecureStore from 'expo-secure-store';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? 'http://localhost:4000';
const PUSH_BASE = `${BACKEND_URL}/api/v1/push`;

async function post(path: string, body: unknown): Promise<void> {
  const token = await SecureStore.getItemAsync('accessToken');
  const res = await fetch(`${PUSH_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
}

export const pushApi = {
  register: (token: string, platform: 'ios' | 'android') => post('/register', { token, platform }),
  unregister: () => post('/unregister', {}),
};
