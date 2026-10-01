import { io, type Socket } from "socket.io-client";
import type {
  AccountLinkedPayload,
  ForceLogoutPayload,
  LinkExpiredPayload,
  LogoutResponse,
  RefreshRequest,
  RefreshResponse,
  RegisterLinkingRequest,
  RegisterLinkingResponse,
  ScanLinkingResponse,
  LogoutRequest
} from "@wpt/shared";
import { ApiClientError } from "./errors";
import { MockApiClient, getMockServer } from "./mock/client";

export type RealLinkingEvents = {
  accountLinked: (payload: AccountLinkedPayload) => void;
  linkExpired: (payload: LinkExpiredPayload) => void;
  error: (error: Error) => void;
};

export type AuthSocketEvents = {
  force_logout: (payload: ForceLogoutPayload) => void;
  connect_error: (error: Error) => void;
};

export type RealLinkingClient = {
  createToken: () => string;
  register: (request: RegisterLinkingRequest) => { socket: Socket; close: () => void };
  openAuthenticatedSocket: (payload: AccountLinkedPayload) => Socket;
  refresh: (request: RefreshRequest) => Promise<RefreshResponse>;
  logout: (accessToken: string) => Promise<LogoutResponse>;
};

export type LinkingApi = {
  register: (request: RegisterLinkingRequest) => Promise<RegisterLinkingResponse>;
  scan: (request: { token: string; deviceId: string }) => Promise<ScanLinkingResponse>;
  subscribe: (channelId: string, handler: PushHandler) => () => void;
  logout: (request: LogoutRequest) => Promise<LogoutResponse>;
  refresh: (request: RefreshRequest) => Promise<RefreshResponse>;
  getServerBaseUrl: () => Promise<string>;
};

export type PushHandler = (message: import("@wpt/shared").LinkingPushMessage) => void;

export type MockControls = {
  simulateScan: (token: string, deviceId?: string) => Promise<import("@wpt/shared").ScanLinkingResponse>;
  expireToken: (token: string) => void;
  forceLogout: (channelId: string) => void;
  setPhoneOnline: (channelId: string, online: boolean) => void;
};

function origin(value: string): string {
  const url = new URL(value);
  return url.toString().replace(/\/$/, "");
}

function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let raw = "";
  for (const byte of b) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class RealBackendClient implements RealLinkingClient {
  private readonly origin: string;
  private readonly rest: string;
  private readonly socketPath = "/realtime";

  constructor(apiBaseUrl: string) {
    this.origin = origin(apiBaseUrl);
    this.rest = `${this.origin}/api/v1`;
  }

  createToken = newToken;

  register(request: RegisterLinkingRequest) {
    const socket = io(`${this.origin}/linking`, {
      path: this.socketPath,
      transports: ["websocket"]
    });
    socket.on("connect", () => {
      socket.emit("register", request, (ack: RegisterLinkingResponse) => {
        if (!ack?.ok) {
          socket.disconnect();
        }
      });
    });
    return { socket, close: () => socket.close() };
  }

  openAuthenticatedSocket(payload: AccountLinkedPayload) {
    return io(this.origin, {
      path: this.socketPath,
      transports: ["websocket"],
      auth: {
        token: payload.accessToken,
        userId: payload.userId,
        deviceId: payload.deviceId
      }
    });
  }

  async refresh(request: RefreshRequest): Promise<RefreshResponse> {
    const response = await fetch(`${this.rest}/onboarding/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiClientError(payload?.error?.code ?? "INVALID_REFRESH_TOKEN", "Refresh token rejected.");
    }
    return payload as RefreshResponse;
  }

  async logout(accessToken: string): Promise<LogoutResponse> {
    const response = await fetch(`${this.rest}/linking/logoff`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      body: "{}"
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiClientError(payload?.error?.code ?? "INVALID_REQUEST", "Web logoff failed.");
    }
    return payload as LogoutResponse;
  }
}

class MockBackendClient implements RealLinkingClient {
  private readonly mockClient: MockApiClient;

  constructor() {
    this.mockClient = new MockApiClient(getMockServer());
  }

  createToken = newToken;

  register(request: RegisterLinkingRequest) {
    const channelId = crypto.randomUUID();
    let resolveRegister: (value: RegisterLinkingResponse) => void;
    const registerPromise = new Promise<RegisterLinkingResponse>((resolve) => {
      resolveRegister = resolve;
    });

    const socket = {
      on: (event: string, callback: (data: any) => void) => {
        if (event === "connect") {
          setTimeout(() => {
            this.mockClient.linking.register(request).then((response) => {
              if (response.ok) {
                resolveRegister?.(response);
                callback(response);
              } else {
                const error = new Error(response.error);
                (socket as any).emit("error", error);
              }
            });
          }, 0);
        }
      },
      emit: (event: string, data: any, ack?: (response: any) => void) => {
        if (event === "register") {
          this.mockClient.linking.register(data).then((response) => {
            ack?.(response);
          });
        }
      },
      disconnect: () => {},
      close: () => {},
      once: () => {},
      off: () => {},
      listeners: () => [],
      listenerCount: () => 0,
      removeAllListeners: () => socket,
      setMaxListeners: () => socket,
      getMaxListeners: () => 10
    } as unknown as Socket;

    this.mockClient.linking.subscribe(channelId, (message) => {
      if (message.type === "tokens_issued") {
        socket.emit("accountLinked", message);
      } else if (message.type === "link_expired") {
        socket.emit("linkExpired", message);
      }
    });

    return { socket, close: () => {} };
  }

  openAuthenticatedSocket(payload: AccountLinkedPayload) {
    return io("http://localhost:8787", {
      path: "/realtime",
      transports: ["websocket"],
      auth: {
        token: payload.accessToken,
        userId: payload.userId,
        deviceId: payload.deviceId
      }
    });
  }

  async refresh(request: RefreshRequest): Promise<RefreshResponse> {
    return this.mockClient.linking.refresh(request);
  }

  async logout(accessToken: string): Promise<LogoutResponse> {
    return { revoked: true };
  }
}

export function getRealBackendClient(): RealBackendClient {
  const configured = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_API_BASE_URL : "";
  if (!configured) {
    throw new Error("NEXT_PUBLIC_API_BASE_URL is not configured. Set it to your backend URL (e.g., http://localhost:4000)");
  }
  return new RealBackendClient(configured);
}

export { ApiClientError } from "./errors";