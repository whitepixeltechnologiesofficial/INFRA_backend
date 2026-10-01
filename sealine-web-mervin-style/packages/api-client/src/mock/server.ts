import type {
  LinkingPushMessage,
  LogoutRequest,
  LogoutResponse,
  RefreshRequest,
  RefreshResponse,
  RegisterLinkingRequest,
  RegisterLinkingResponse,
  ScanLinkingRequest,
  ScanLinkingResponse
} from "@wpt/shared";
import { ApiClientError } from "../errors";

type Handler = (message: LinkingPushMessage) => void;

type Registration = {
  token: string;
  channelId: string;
  expiresAt: number;
  used: boolean;
  revoked: boolean;
  handlers: Set<Handler>;
  refreshToken?: string;
  accessToken?: string;
  phoneOnline: boolean;
};

export type MockServerOptions = {
  clock?: () => number;
};

export class MockLinkingServer {
  private readonly clock: () => number;
  private readonly registrations = new Map<string, Registration>();
  private readonly tokenToChannel = new Map<string, string>();

  constructor(options: MockServerOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
  }

  register(request: RegisterLinkingRequest): RegisterLinkingResponse {
    if (request.ttlSeconds !== 60 || !request.token || !request.identityBundle) {
      throw new ApiClientError("INVALID_REQUEST", "Invalid linking registration.");
    }

    const existing = this.tokenToChannel.get(request.token);
    if (existing) {
      throw new ApiClientError("TOKEN_REUSED", "This linking token has already been registered.");
    }

    const channelId = crypto.randomUUID();
    const expiresAt = this.clock() + 60_000;

    const registration: Registration = {
      token: request.token,
      channelId,
      expiresAt,
      used: false,
      revoked: false,
      handlers: new Set(),
      phoneOnline: true
    };

    this.registrations.set(channelId, registration);
    this.tokenToChannel.set(request.token, channelId);

    return { ok: true, channelId, expiresAt };
  }

  subscribe(channelId: string, handler: Handler): () => void {
    const registration = this.requireChannel(channelId);
    registration.handlers.add(handler);
    return () => registration.handlers.delete(handler);
  }

  scan(request: ScanLinkingRequest): ScanLinkingResponse {
    const channelId = this.tokenToChannel.get(request.token);

    if (!channelId) {
      throw new ApiClientError("TOKEN_NOT_FOUND", "Linking QR token was not found.");
    }

    const registration = this.requireChannel(channelId);

    if (this.clock() >= registration.expiresAt) {
      throw new ApiClientError(
        "TOKEN_EXPIRED",
        "Linking token expired. Refresh the QR code and scan the new token."
      );
    }

    if (registration.used || registration.revoked) {
      throw new ApiClientError(
        "TOKEN_REUSED",
        "This linking token has already been used. Refresh the QR code."
      );
    }

    registration.used = true;

    const sessionId = crypto.randomUUID();
    const accessToken = `access_${crypto.randomUUID()}`;
    const refreshToken = `refresh_${crypto.randomUUID()}`;

    registration.accessToken = accessToken;
    registration.refreshToken = refreshToken;

    const message: LinkingPushMessage = {
      type: "tokens_issued",
      channelId,
      sessionId,
      accessToken,
      refreshToken,
      issuedAt: this.clock()
    };

    queueMicrotask(() => this.emit(registration, message));

    return { accepted: true, channelId };
  }

  logout(request: LogoutRequest): LogoutResponse {
    const registration = this.requireChannel(request.channelId);

    if (registration.refreshToken !== request.refreshToken || registration.revoked) {
      throw new ApiClientError(
        "REFRESH_REVOKED",
        "The refresh token has been revoked."
      );
    }

    registration.revoked = true;
    registration.accessToken = undefined;
    registration.refreshToken = undefined;

    return { revoked: true };
  }

  refresh(request: RefreshRequest): RefreshResponse {
    for (const registration of this.registrations.values()) {
      if (registration.refreshToken === request.refreshToken) {
        if (registration.revoked) {
          throw new ApiClientError(
            "SESSION_REVOKED",
            "This session has been revoked."
          );
        }

        const accessToken = `access_${crypto.randomUUID()}`;
        const refreshToken = `refresh_${crypto.randomUUID()}`;

        registration.accessToken = accessToken;
        registration.refreshToken = refreshToken;

        return { accessToken, refreshToken };
      }
    }

    throw new ApiClientError(
      "REFRESH_REVOKED",
      "The refresh token has been revoked."
    );
  }

  forceLogout(channelId: string): void {
    const registration = this.requireChannel(channelId);
    registration.revoked = true;
    registration.accessToken = undefined;
    registration.refreshToken = undefined;

    const message: LinkingPushMessage = {
      type: "force_logout",
      channelId,
      reason: "new_phone_login",
      issuedAt: this.clock()
    };

    queueMicrotask(() => this.emit(registration, message));
  }

  setPhoneOnline(channelId: string, online: boolean): void {
    const registration = this.requireChannel(channelId);
    registration.phoneOnline = online;

    const message: LinkingPushMessage = {
      type: "phone_status",
      channelId,
      online,
      issuedAt: this.clock()
    };

    queueMicrotask(() => this.emit(registration, message));
  }

  expireToken(token: string): void {
    const channelId = this.tokenToChannel.get(token);
    if (!channelId) return;
    const registration = this.requireChannel(channelId);
    registration.expiresAt = this.clock() - 1;
  }

  private emit(registration: Registration, message: LinkingPushMessage): void {
    for (const handler of registration.handlers) {
      handler(message);
    }
  }

  private requireChannel(channelId: string): Registration {
    const registration = this.registrations.get(channelId);
    if (!registration) {
      throw new ApiClientError("TOKEN_NOT_FOUND", "Linking channel was not found.");
    }
    return registration;
  }
}