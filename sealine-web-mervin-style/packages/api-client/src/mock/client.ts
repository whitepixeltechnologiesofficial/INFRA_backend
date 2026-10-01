import type { LinkingApi, MockControls, PushHandler } from "../index";
import type {
  LogoutRequest,
  RefreshRequest,
  RegisterLinkingRequest,
  ScanLinkingRequest
} from "@wpt/shared";
import { MockLinkingServer } from "./server";

export class MockApiClient {
  constructor(private readonly server: MockLinkingServer) {}

  linking: LinkingApi = {
    register: async (request: RegisterLinkingRequest) =>
      this.server.register(request),

    scan: async (request: ScanLinkingRequest) =>
      this.server.scan(request),

    subscribe: (channelId: string, handler: PushHandler) =>
      this.server.subscribe(channelId, handler),

    logout: async (request: LogoutRequest) =>
      this.server.logout(request),

    refresh: async (request: RefreshRequest) =>
      this.server.refresh(request),

    getServerBaseUrl: async () => "http://localhost:8787"
  };

  controls: MockControls = {
    simulateScan: async (token, deviceId = "mock-phone") =>
      this.server.scan({ token, deviceId }),
    expireToken: (token) => this.server.expireToken(token),
    forceLogout: (channelId) => this.server.forceLogout(channelId),
    setPhoneOnline: (channelId, online) =>
      this.server.setPhoneOnline(channelId, online)
  };
}

let singleton: MockLinkingServer | undefined;

export function getMockServer(): MockLinkingServer {
  singleton ??= new MockLinkingServer();
  return singleton;
}