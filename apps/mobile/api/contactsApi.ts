// api/contactsApi.ts
//
// PERM-2.3 / PERM-2.4 — the real contact-matching endpoint
// (apps/backend/src/routes/contacts.ts). Only 64-hex SHA-256 digests are ever
// sent; match() refuses anything else before a request is built.

import * as SecureStore from 'expo-secure-store';
import { isContactHash } from '@/lib/contact-hash';
import type { MatchedUser } from '@/lib/contact-sync-core';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? 'http://localhost:4000';
const CONTACTS_BASE = `${BACKEND_URL}/api/v1/contacts`;

async function authed<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  const token = await SecureStore.getItemAsync('accessToken');
  const res = await fetch(`${CONTACTS_BASE}${path}`, {
    method: init.method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    (error as any).status = res.status;
    throw error;
  }
  return data as T;
}

let cachedSalt: string | null = null;

export const contactsApi = {
  async getSalt(): Promise<string> {
    if (cachedSalt) return cachedSalt;
    const cfg = await authed<{ salt: string }>('/config', { method: 'GET' });
    if (!cfg.salt) throw new Error('HASH_SALT_NOT_CONFIGURED');
    cachedSalt = cfg.salt;
    return cachedSalt;
  },

  async match(hashes: string[]): Promise<MatchedUser[]> {
    if (!hashes.every(isContactHash)) throw new Error('RAW_VALUE_BLOCKED');
    const res = await authed<{ matches: MatchedUser[] }>('/match', { method: 'POST', body: { hashes } });
    return res.matches ?? [];
  },
};
