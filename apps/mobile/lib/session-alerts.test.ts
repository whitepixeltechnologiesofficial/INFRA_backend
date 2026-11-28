import { FORCE_LOGOUT_ALERT, LOGIN_HERE_ALERT } from './session-alerts';

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

function assertEqual<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

check('new-device login popup matches restored text', () => {
  assertEqual(LOGIN_HERE_ALERT.title, 'Logged in here');
  assertEqual(LOGIN_HERE_ALERT.message, "You're now logged in here. This phone is your active device.");
  assertEqual(LOGIN_HERE_ALERT.button, 'Continue');
});

check('old-device force-logout popup matches restored text', () => {
  assertEqual(FORCE_LOGOUT_ALERT.title, 'Signed out of this device');
  assertEqual(
    FORCE_LOGOUT_ALERT.message,
    'Your account was just signed in on another device, so we ended the session here. Sign in again to continue.',
  );
});

console.log(`${passed} passed, 0 failed`);
