import * as SecureStore from 'expo-secure-store';

const API_VERSION = 'v1';

const BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '');

export function isBackendConfigured(): boolean {
  return BASE_URL.length > 0;
}

export function getBackendUrl(): string {
  return BASE_URL;
}

async function post<T>(path: string, body?: unknown, token?: string | null): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let data: { error?: string } | null = null;
    try {
      data = (await res.json()) as { error?: string };
    } catch {
      // non-JSON error body
    }
    const err = new Error(data?.error ?? `HTTP ${res.status}`) as Error & {
      status?: number;
      error?: string;
    };
    err.status = res.status;
    err.error = data?.error;
    throw err;
  }

  return (await res.json()) as T;
}

export type BackendVerifyOtpSuccess = {
  status: 'success';
  routing: 'chats' | 'profile_setup';
  accessToken: string;
  refreshToken: string;
  userId: string;
  sessionId: string;
  previousDevicesLoggedOut: number;
};

export type BackendVerifyOtpWrongCode = {
  status: 'wrong_code';
  attemptsRemaining: number;
};

export type BackendVerifyOtpLockedOut = {
  status: 'locked_out';
  secondsRemaining: number;
};

export type BackendVerifyOtpExpired = {
  status: 'expired';
};

export type BackendVerifyOtpAttemptsExhausted = {
  status: 'attempts_exhausted';
};

export type BackendVerifyOtpResult =
  | BackendVerifyOtpSuccess
  | BackendVerifyOtpWrongCode
  | BackendVerifyOtpLockedOut
  | BackendVerifyOtpExpired
  | BackendVerifyOtpAttemptsExhausted;

export const backendClient = {
  isConfigured: isBackendConfigured,

  baseUrl: BASE_URL,

  async sendOtp({ phoneNumber }: { phoneNumber: string }): Promise<{ success: true }> {
    return post<{ success: true }>(`/api/${API_VERSION}/onboarding/otp/send`, { phoneNumber });
  },

  async verifyOtp({
    phoneNumber,
    code,
    deviceId,
  }: {
    phoneNumber: string;
    code: string;
    deviceId?: string;
  }): Promise<BackendVerifyOtpResult> {
    return post<BackendVerifyOtpResult>(`/api/${API_VERSION}/onboarding/otp/verify`, {
      phoneNumber,
      code,
      deviceId,
    });
  },

  async checkSessionValidity({
    deviceId,
  }: {
    deviceId: string;
  }): Promise<{ isValid: boolean; message?: string }> {
    const token = await SecureStore.getItemAsync('accessToken');
    if (!token) {
      return { isValid: false, message: 'No access token' };
    }
    return post<{ isValid: boolean; message?: string }>(
      `/api/${API_VERSION}/onboarding/session/check`,
      { deviceId },
      token,
    );
  },

  async acceptLegal(phoneNumber: string): Promise<{ success: true }> {
    return post<{ success: true }>(`/api/${API_VERSION}/onboarding/accept-legal`, { phoneNumber });
  },

  async checkExistingUser({ phoneNumber }: { phoneNumber: string }): Promise<{ exists: boolean }> {
    return post<{ exists: boolean }>(`/api/${API_VERSION}/onboarding/check-existing-user`, {
      phoneNumber,
    });
  },

  async handleLoginHandoff({
    refreshToken,
    deviceInfo,
  }: {
    refreshToken: string;
    deviceInfo: {
      deviceId: string;
      deviceName: string;
      platform: 'ios' | 'android' | 'web';
    };
  }): Promise<{
    success: true;
    sessionId: string;
    accessToken: string;
    refreshToken: string;
    message: string;
    previousDevicesLoggedOut: number;
  }> {
    return post(`/api/${API_VERSION}/onboarding/login/handoff`, {
      refreshToken,
      deviceInfo,
    });
  },

  async refreshTokens(refreshToken: string): Promise<{ accessToken: string }> {
    return post<{ accessToken: string }>(`/api/${API_VERSION}/onboarding/refresh`, {
      refreshToken,
    });
  },
};
