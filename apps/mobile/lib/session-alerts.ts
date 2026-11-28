export const LOGIN_HERE_ALERT = {
  title: 'Logged in here',
  message: "You're now logged in here. This phone is your active device.",
  button: 'Continue',
} as const;

export const FORCE_LOGOUT_ALERT = {
  title: 'Signed out of this device',
  message:
    'Your account was just signed in on another device, so we ended the session here. Sign in again to continue.',
} as const;
