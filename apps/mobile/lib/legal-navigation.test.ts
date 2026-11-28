import {
  resolveLegalAcceptResult,
  resolveSplashDestination,
} from './legal-navigation';

let passed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function assertDeepEqual(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}

check('splash proceeds to chats when a session is active', () => {
  assertDeepEqual(resolveSplashDestination({ hasSession: true }), { pathname: '/(tabs)' });
});

check('splash proceeds to legal acceptance when the device is logged out', () => {
  assertDeepEqual(resolveSplashDestination({ hasSession: false }), {
    pathname: '/legal-acceptance',
  });
});

check('accepting a pending flow continues to OTP', () => {
  assertDeepEqual(
    resolveLegalAcceptResult({
      phoneNumber: '+15551234567',
      displayPhone: '+1 555 123 4567',
      hasSession: false,
    }),
    {
      pathname: '/otp-entry',
      params: { phoneNumber: '+15551234567', displayPhone: '+1 555 123 4567' },
    },
  );
});

check('accepting without a pending flow resumes an existing session', () => {
  assertDeepEqual(
    resolveLegalAcceptResult({
      phoneNumber: '',
      displayPhone: '',
      hasSession: true,
    }),
    { pathname: '/(tabs)' },
  );
});

check('accepting without a pending flow and session starts phone entry', () => {
  assertDeepEqual(
    resolveLegalAcceptResult({
      phoneNumber: '',
      displayPhone: '',
      hasSession: false,
    }),
    { pathname: '/phone-entry' },
  );
});

console.log(`${passed} passed, 0 failed`);
