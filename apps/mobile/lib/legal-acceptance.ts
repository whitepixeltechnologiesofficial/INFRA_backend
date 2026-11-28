// lib/legal-acceptance.ts
//
// Durable legal acceptance gate. Uses expo-secure-store so the choice survives
// app restores and OS upgrades. The version string is compared against the
// backend legalVersion field to detect out-of-date acceptance.

import * as SecureStore from 'expo-secure-store';

const KEY = 'legalAcceptedVersion';
const LEGAL_ACCEPTANCE_VERSION = 'v2.0';

export async function hasAcceptedLegal(): Promise<boolean> {
  try {
    const stored = await SecureStore.getItemAsync(KEY);
    return stored === LEGAL_ACCEPTANCE_VERSION;
  } catch {
    return false;
  }
}

export async function recordLegalAcceptance(): Promise<void> {
  await SecureStore.setItemAsync(KEY, LEGAL_ACCEPTANCE_VERSION);
}

export async function requireLegalAccepted(): Promise<boolean> {
  return hasAcceptedLegal();
}