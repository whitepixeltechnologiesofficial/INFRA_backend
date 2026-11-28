export type LegalAcceptResult =
  | {
      pathname: '/otp-entry';
      params: { phoneNumber: string; displayPhone: string };
    }
  | { pathname: '/(tabs)' }
  | { pathname: '/phone-entry' };

export type SplashDestination = { pathname: '/(tabs)' } | { pathname: '/legal-acceptance' };

export function resolveSplashDestination(input: { hasSession: boolean }): SplashDestination {
  return input.hasSession ? { pathname: '/(tabs)' } : { pathname: '/legal-acceptance' };
}

export function resolveLegalAcceptResult(input: {
  phoneNumber: string;
  displayPhone: string;
  hasSession: boolean;
}): LegalAcceptResult {
  if (input.phoneNumber.length > 0) {
    return {
      pathname: '/otp-entry',
      params: {
        phoneNumber: input.phoneNumber,
        displayPhone: input.displayPhone,
      },
    };
  }

  return input.hasSession ? { pathname: '/(tabs)' } : { pathname: '/phone-entry' };
}
