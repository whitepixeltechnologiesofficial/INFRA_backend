// api/onboardingApi.ts
//
// ONB — API layer for onboarding.
//
// This is an in-memory MOCK implementation of the backend contract for single-
// device development. All state lives in memory and resets on app restart. It
// stands in for the real Express backend so the app can run without a network
// / backend process. The exported types and the `onboardingApi` object shape
// match the live fetch-based contract exactly, so callers need no changes.
//
// ONB-1.7 multi-device mode: when EXPO_PUBLIC_USE_MOCK=false AND
// EXPO_PUBLIC_API_BASE_URL is reachable, the auth/session operations are
// delegated to the real backend (`backendClient`). The backend keeps the
// shared account/device/session registry, so two physical devices that both
// connect to the SAME backend instance can observe each other's logins — a
// login on Device B revokes Device A's session server-side, and Device A
// detects it via force_logout push / session check. This is the ONLY path that
// provides genuine shared state between devices; the in-memory mock is never
// used for the two-device ONB-1.7 verification.
// ── Mock-internal state & constants ──

const IS_MOCK_MODE = process.env.EXPO_PUBLIC_USE_MOCK !== 'false';
const IS_BACKEND_MODE = !IS_MOCK_MODE && (process.env.EXPO_PUBLIC_API_BASE_URL ?? '') !== '';

/**
 * Lazily resolve the real backend HTTP client. backloaded lazily so headless
 * Node test harnesses (which stub `@/` imports but have no expo-secure-store
 * runtime) can still import onboardingApi in mock mode without pulling in
 * expo-secure-store. Only ever touched when IS_BACKEND_MODE is true.
 */
function getBackendClient() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('./backendClient') as typeof import('./backendClient');
  return mod.backendClient;
}

const MOCK_OTP_CODE = '123456';
const MAX_ATTEMPTS = 3;
const LOCKOUT_MS = 30_000;
const OTP_EXPIRY_MS = 5 * 60_000;
const RESEND_COOLDOWN_MS = 30_000;

// Pre-registered numbers → logged-in users route straight to Chats after OTP.
const REGISTERED_NUMBERS = new Set<string>([
  '+911234567890',
  '+919876543210',
  '+14155552671',
]);

// Legal acceptance is durable app-lifetime state (separate from an OTP session).
const acceptedLegalNumbers = new Set<string>();

type OtpSession = {
  phoneNumber: string;
  sentAt: number;
  attemptsUsed: number;
  lockedUntil: number | null;
  code: string;
  legalAccepted: boolean;
};

// Per-phone OTP sessions (ONB-1.4 / SEC): attempts, lockout, resend cooldown
// and legal acceptance are tracked per phone number so one account's failed
// attempts never bleed into another's, stale sessions can't leak, and there is
// never a single global mutable counter shared across all users.
const otpSessions = new Map<string, OtpSession>();

function getOtpSession(phoneNumber: string): OtpSession | undefined {
  return otpSessions.get(phoneNumber);
}

type MockProfile = {
  id: string;
  name: string;
  photo?: string;
  about: string;
  phoneNumber: string;
  createdAt: string;
  updatedAt: string;
};

const registeredProfiles = new Map<string, MockProfile>();

// ONB-1.7 mock bookkeeping (single-device dev only): per-phone stable user
// identity + per-user session log so re-login of the same number is coherent.
// Multi-device revocation is intentionally NOT simulated here — it requires the
// shared backend (IS_BACKEND_MODE).
const mockUserIdsByPhone = new Map<string, string>();
const mockUserSessionsByUser = new Map<string, { sessionId: string; deviceId: string | null }[]>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now(): number {
  return Date.now();
}

function issueToken(): string {
  return `mock_token_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function findProfileByPhone(phoneNumber: string): MockProfile | undefined {
  return registeredProfiles.get(phoneNumber);
}

// ── Types (mirror the live API contract) ──

export type SendOtpParams = { phoneNumber: string };
export type SendOtpResult = { success: true };

export type VerifyOtpParams = { phoneNumber: string; code: string; deviceId?: string };
export type VerifyOtpResult =
  | {
      status: 'success';
      routing: 'chats' | 'profile_setup';
      accessToken: string;
      refreshToken: string;
      userId: string;
      sessionId: string;
      // ONB-1.7: number of previously active sessions revoked by this login.
      // 0 = first login (or no other active devices); >0 = this is a new-device
      // (or re-) login that silently cut off other devices.
      previousDevicesLoggedOut: number;
    }
  | { status: 'wrong_code'; attemptsRemaining: number }
  | { status: 'locked_out'; secondsRemaining: number }
  | { status: 'attempts_exhausted' }
  | { status: 'expired' };

export type CheckExistingUserParams = { phoneNumber: string };
export type CheckExistingUserResult = { exists: boolean };

export type CreateProfileParams = {
  name: string;
  photo?: string;
  about: string;
};

export type CreateProfileResult = {
  success: true;
  userId: string;
  profile: {
    id: string;
    name: string;
    photo?: string;
    about: string;
    phoneNumber: string;
    createdAt: string;
  };
};

export type GetProfileResult = {
  id: string;
  name: string;
  photo?: string;
  about: string;
  phoneNumber: string;
  createdAt: string;
  updatedAt: string;
};

export type UpdateProfileParams = {
  name?: string;
  photo?: string;
  about?: string;
};

export type UpdateProfileResult = {
  success: true;
  profile: GetProfileResult;
};

export type LoginHandoffParams = {
  refreshToken: string;
  deviceInfo: {
    deviceId: string;
    deviceName: string;
    platform: 'ios' | 'android' | 'web';
  };
};

export type LoginHandoffResult = {
  success: true;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  message: string;
  previousDevicesLoggedOut: number;
};

// ── Mock API implementation ──

export const onboardingApi = {
  async sendOtp({ phoneNumber }: SendOtpParams): Promise<SendOtpResult> {
    if (IS_BACKEND_MODE) {
      return getBackendClient().sendOtp({ phoneNumber });
    }
    await delay(400);

    // LEGAL-GATE — an OTP is only issued after acceptance for this number was
    // recorded via acceptLegal (from the authorized checkbox flow). Mirrors the
    // real backend's requireLegalAcceptance().
    if (!acceptedLegalNumbers.has(phoneNumber)) {
      throw Object.assign(new Error('LEGAL_NOT_ACCEPTED'), { status: 403 });
    }

    if (getOtpSession(phoneNumber)) {
      const sess = otpSessions.get(phoneNumber)!;
      // Lockout (SEC): a fresh OTP must NOT clear an active 30s lockout. The
      // user stays blocked until the lockout fully expires — a resend cannot
      // be used to bypass it (issue 25).
      if (sess.lockedUntil && now() < sess.lockedUntil) {
        throw Object.assign(new Error('OTP_LOCKED_OUT'), { status: 429 });
      }
      const elapsed = now() - sess.sentAt;
      if (elapsed < RESEND_COOLDOWN_MS) {
        throw Object.assign(new Error('RESEND_COOLDOWN_ACTIVE'), { status: 429 });
      }
    }

    otpSessions.set(phoneNumber, {
      phoneNumber,
      sentAt: now(),
      attemptsUsed: 0,
      lockedUntil: null,
      code: MOCK_OTP_CODE,
      legalAccepted: true,
    });

    return { success: true };
  },

  async verifyOtp({ phoneNumber, code, deviceId }: VerifyOtpParams): Promise<VerifyOtpResult> {
    if (IS_BACKEND_MODE) {
      return getBackendClient().verifyOtp({ phoneNumber, code, deviceId });
    }
    await delay(400);

    const existing = getOtpSession(phoneNumber);
    if (!existing) {
      throw Object.assign(new Error('NO_ACTIVE_SESSION'), { status: 404 });
    }

    const session = { ...existing };

    if (!session.legalAccepted) {
      throw Object.assign(new Error('LEGAL_NOT_ACCEPTED'), { status: 403 });
    }

    if (session.lockedUntil && now() < session.lockedUntil) {
      return {
        status: 'locked_out',
        secondsRemaining: Math.ceil((session.lockedUntil - now()) / 1000),
      };
    }

    if (now() - session.sentAt > OTP_EXPIRY_MS) {
      otpSessions.delete(phoneNumber);
      return { status: 'expired' };
    }

    // SEC (4th-attempt rule): once the 3 allowed attempts are used, a further
    // attempt — even with the correct code — must NOT succeed until the lockout
    // has fully elapsed. This is enforced on the authoritative (mock API) layer,
    // not only by disabling UI inputs.
    if (session.attemptsUsed >= MAX_ATTEMPTS) {
      if (session.lockedUntil && now() < session.lockedUntil) {
        return {
          status: 'locked_out',
          secondsRemaining: Math.ceil((session.lockedUntil - now()) / 1000),
        };
      }
      // Lockout expired but attempts still exhausted → remain blocked.
      return { status: 'attempts_exhausted' };
    }

    if (code === session.code) {
      otpSessions.delete(phoneNumber);

      const displayPhone = session.phoneNumber;

      // Mock keeps a stable per-phone user identity so a re-login of the same
      // number resolves to the same account (matches the real backend, which
      // keys users by phone). Device/session revocation is NOT simulated here —
      // genuine multi-device state requires the shared backend (IS_BACKEND_MODE).
      let userId = mockUserIdsByPhone.get(displayPhone);
      if (!userId) {
        userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        mockUserIdsByPhone.set(displayPhone, userId);
      }

      const userSessions = mockUserSessionsByUser.get(userId);
      const previousDevicesLoggedOut =
        userSessions && userSessions.length > 0 ? userSessions.length : 0;

      const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      if (!mockUserSessionsByUser.has(userId)) {
        mockUserSessionsByUser.set(userId, []);
      }
      mockUserSessionsByUser.get(userId)!.push({ sessionId, deviceId: deviceId ?? null });

      const existing = findProfileByPhone(displayPhone);

      // Pre-registered users already have a profile → go straight to Chats.
      const routing: 'chats' | 'profile_setup' =
        existing || REGISTERED_NUMBERS.has(displayPhone) ? 'chats' : 'profile_setup';

      return {
        status: 'success',
        routing,
        accessToken: issueToken(),
        refreshToken: issueToken(),
        userId,
        sessionId,
        previousDevicesLoggedOut,
      };
    }

    // Wrong code — increment attempts for THIS phone's session only.
    const mutable = otpSessions.get(phoneNumber)!;
    mutable.attemptsUsed += 1;
    const attemptsRemaining = MAX_ATTEMPTS - mutable.attemptsUsed;

    if (attemptsRemaining <= 0) {
      // 3rd wrong attempt → start the 30-second lockout (per-phone). Return
      // `locked_out` so the OTP screen renders a live countdown with the input
      // disabled (matches the PRD's visible-lockout UI).
      mutable.lockedUntil = now() + LOCKOUT_MS;
      return {
        status: 'locked_out',
        secondsRemaining: Math.ceil(LOCKOUT_MS / 1000),
      };
    }

    return { status: 'wrong_code', attemptsRemaining };
  },

  async checkExistingUser({ phoneNumber }: CheckExistingUserParams): Promise<CheckExistingUserResult> {
    if (IS_BACKEND_MODE) {
      return getBackendClient().checkExistingUser({ phoneNumber });
    }
    await delay(300);
    return { exists: REGISTERED_NUMBERS.has(phoneNumber) || registeredProfiles.has(phoneNumber) };
  },

  async handleLoginHandoff({
    refreshToken,
    deviceInfo,
  }: LoginHandoffParams): Promise<LoginHandoffResult> {
    if (IS_BACKEND_MODE) {
      return getBackendClient().handleLoginHandoff({ refreshToken, deviceInfo });
    }
    await delay(300);

    if (!refreshToken) {
      throw Object.assign(new Error('INVALID_REFRESH_TOKEN'), { status: 401 });
    }

    return {
      success: true,
      sessionId: `session_${Date.now()}`,
      accessToken: issueToken(),
      refreshToken: issueToken(),
      message: 'Logged in on this device. Other devices were logged out.',
      previousDevicesLoggedOut: 1,
    };
  },

  async checkSessionValidity({
    deviceId,
  }: {
    deviceId: string;
  }): Promise<{ isValid: boolean; message?: string }> {
    if (IS_BACKEND_MODE) {
      return getBackendClient().checkSessionValidity({ deviceId });
    }
    await delay(250);

    // Mock always treats the local session as valid — no remote revocation exists.
    if (!deviceId) {
      return { isValid: false, message: 'Missing device id' };
    }
    return { isValid: true };
  },

  async createProfile({ name, photo, about }: CreateProfileParams): Promise<CreateProfileResult> {
    await delay(500);

    if (!name || name.trim().length === 0) {
      throw Object.assign(new Error('NAME_REQUIRED'), { status: 400 });
    }

    const id = `user_${Date.now()}`;
    const profile: MockProfile = {
      id,
      name: name.trim(),
      photo,
      about: about.trim() || "Hey there! I'm using ONB",
      phoneNumber: `+${Math.floor(1000000000 + Math.random() * 8999999999)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    registeredProfiles.set(profile.phoneNumber, profile);

    return {
      success: true,
      userId: id,
      profile: {
        id: profile.id,
        name: profile.name,
        photo: profile.photo,
        about: profile.about,
        phoneNumber: profile.phoneNumber,
        createdAt: profile.createdAt,
      },
    };
  },

  async getProfile(): Promise<GetProfileResult> {
    await delay(300);

    const profile = registeredProfiles.values().next().value as MockProfile | undefined;
    if (!profile) {
      throw Object.assign(new Error('PROFILE_NOT_FOUND'), { status: 404 });
    }

    return { ...profile };
  },

  async updateProfile({ name, photo, about }: UpdateProfileParams): Promise<UpdateProfileResult> {
    await delay(300);

    const profile = registeredProfiles.values().next().value as MockProfile | undefined;
    if (!profile) {
      throw Object.assign(new Error('PROFILE_NOT_FOUND'), { status: 404 });
    }

    if (name !== undefined && name.trim().length === 0) {
      throw Object.assign(new Error('NAME_REQUIRED'), { status: 400 });
    }

    if (name !== undefined) profile.name = name.trim();
    if (photo !== undefined) profile.photo = photo;
    if (about !== undefined) profile.about = about.trim();
    profile.updatedAt = new Date().toISOString();

    return { success: true, profile: { ...profile } };
  },

  async acceptLegal(phoneNumber: string): Promise<{ success: true }> {
    if (IS_BACKEND_MODE) {
      return getBackendClient().acceptLegal(phoneNumber);
    }
    await delay(200);
    acceptedLegalNumbers.add(phoneNumber);
    const sess = getOtpSession(phoneNumber);
    if (sess) {
      sess.legalAccepted = true;
    }
    return { success: true };
  },

  async refreshTokens(refreshToken: string): Promise<{ accessToken: string }> {
    await delay(200);
    if (!refreshToken) {
      throw Object.assign(new Error('INVALID_REFRESH_TOKEN'), { status: 401 });
    }
    return { accessToken: issueToken() };
  },
};

// ── Dev/test helpers (not used by screens) ──
export const mockState = {
  acceptedLegalNumbers,
  clearOtpSession(phoneNumber?: string) {
    if (phoneNumber) {
      otpSessions.delete(phoneNumber);
    } else {
      otpSessions.clear();
    }
  },
  otpSessionCount() {
    return otpSessions.size;
  },
  clearAll() {
    otpSessions.clear();
    acceptedLegalNumbers.clear();
    registeredProfiles.clear();
    mockUserIdsByPhone.clear();
    mockUserSessionsByUser.clear();
  },
};
