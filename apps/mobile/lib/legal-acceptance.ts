// lib/legal-acceptance.ts
//
// LEGAL-GATE — Durable legal-acceptance gate (ONB-1.3).
//
// The "I agree" checkbox on legal-acceptance is the ONLY authorized path that
// marks terms as accepted. Acceptance is written to a durable store
// (SecureStore). Every protected business screen (otp-entry, device-handoff)
// must call `requireLegalAccepted()` before doing its work so the gate cannot
// be skipped by navigating straight to a URL.
import * as SecureStore from 'expo-secure-store';

export const LEGAL_ACCEPTANCE_STORAGE_KEY = 'onb.legalAccepted';
export const LEGAL_ACCEPTED_VALUE = 'true';

export function isLegalAcceptedValue(value: string | null): boolean {
  return value === LEGAL_ACCEPTED_VALUE;
}

export function recordLegalAcceptance(): Promise<void> {
  return SecureStore.setItemAsync(LEGAL_ACCEPTANCE_STORAGE_KEY, LEGAL_ACCEPTED_VALUE);
}

export function clearLegalAcceptance(): Promise<void> {
  return SecureStore.setItemAsync(LEGAL_ACCEPTANCE_STORAGE_KEY, '');
}

export async function hasAcceptedLegal(): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(LEGAL_ACCEPTANCE_STORAGE_KEY);
  return isLegalAcceptedValue(raw);
}

export async function requireLegalAccepted(): Promise<boolean> {
  return hasAcceptedLegal();
}