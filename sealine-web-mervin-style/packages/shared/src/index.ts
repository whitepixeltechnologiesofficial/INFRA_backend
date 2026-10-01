export const LINKING_TOKEN_TTL_SECONDS = 60 as const;
export const API_VERSION = "v1" as const;
export const SOCKET_NAMESPACE = "/realtime" as const;

export type UserId = string;
export type DeviceId = string;

export type RegisterLinkingRequest = {
  token: string;
  ttlSeconds: 60;
  identityBundle: {
    version: 1;
    identityId: string;
    algorithm: "ECDH-P256";
    publicKeyJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  };
};

export type RegisterLinkingResponse =
  | { ok: true; channelId: string; expiresAt: number }
  | { ok: false; error: "INVALID_REGISTRATION" };

export type ScanLinkingRequest = { token: string; deviceId: string };

export type ScanLinkingResponse =
  | { accepted: true; channelId: string }
  | { accepted: false; error: "TOKEN_NOT_FOUND" | "TOKEN_EXPIRED" | "TOKEN_REUSED" };

export type LinkingPushMessage =
  | { type: "tokens_issued"; channelId: string; sessionId: string; accessToken: string; refreshToken: string; issuedAt: number }
  | { type: "link_expired"; channelId: string; reason: "ttl" }
  | { type: "force_logout"; channelId: string; reason: "new_phone_login"; issuedAt: number }
  | { type: "phone_status"; channelId: string; online: boolean; issuedAt: number };

export type LogoutRequest = { channelId: string; refreshToken: string };

export type LogoutResponse = { revoked: true } | { error: "REFRESH_REVOKED" };

export type RefreshRequest = { refreshToken: string };

export type RefreshResponse = { accessToken: string; refreshToken: string } | { error: "REFRESH_REVOKED" | "SESSION_REVOKED" };

export type AccountLinkedPayload = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  deviceId: string;
  sessionId: string;
};

export type LinkExpiredPayload = {
  reason?: string;
};

export type ForceLogoutPayload = Record<string, never>;

export type QrPayload = { version: 1; type: "sealine_web_link"; token: string };

export type ApiErrorCode =
  | "INVALID_REQUEST"
  | "TOKEN_NOT_FOUND"
  | "TOKEN_EXPIRED"
  | "TOKEN_REUSED"
  | "REFRESH_REVOKED"
  | "SESSION_REVOKED"
  | "INVALID_REFRESH_TOKEN"
  | "INVALID_REGISTRATION"
  | "NOT_A_WEB_SESSION"
  | "DEVICE_NOT_FOUND"
  | "LOGOFF_FAILED"
  | "LINK_FAILED"
  | "LINKING_SCAN_RATE_LIMITED";

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    message: string;
  };
};