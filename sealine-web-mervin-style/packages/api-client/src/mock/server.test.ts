import { describe, expect, it } from "vitest";
import type { RegisterLinkingRequest } from "@wpt/shared";
import { ApiClientError } from "../errors";
import { MockLinkingServer } from "./server";

function request(token = "token-1"): RegisterLinkingRequest {
  return {
    token,
    ttlSeconds: 60,
    identityBundle: {
      version: 1,
      identityId: "web-1",
      algorithm: "ECDH-P256",
      publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }
    }
  };
}

describe("MockLinkingServer", () => {
  it("pushes tokens instead of returning them from scan", async () => {
    const server = new MockLinkingServer();
    const registered = server.register(request());
    let pushed: unknown;

    server.subscribe(registered.channelId, (message) => {
      pushed = message;
    });

    const response = server.scan({ token: "token-1", deviceId: "phone-1" });

    expect(response).toEqual({
      accepted: true,
      channelId: registered.channelId
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pushed).toMatchObject({
      type: "tokens_issued",
      channelId: registered.channelId
    });
    expect(response).not.toHaveProperty("accessToken");
    expect(response).not.toHaveProperty("refreshToken");
  });

  it("rejects a token after 60 seconds", () => {
    let now = 1_000_000;
    const server = new MockLinkingServer({ clock: () => now });
    server.register(request());

    now += 60_001;

    expect(() =>
      server.scan({ token: "token-1", deviceId: "phone-1" })
    ).toThrowError(ApiClientError);

    try {
      server.scan({ token: "token-1", deviceId: "phone-1" });
    } catch (error) {
      expect(error).toMatchObject({ code: "TOKEN_EXPIRED" });
    }
  });

  it("rejects a reused token", () => {
    const server = new MockLinkingServer();
    const registered = server.register(request());

    server.scan({ token: "token-1", deviceId: "phone-1" });

    expect(() =>
      server.scan({ token: "token-1", deviceId: "phone-2" })
    ).toThrowError(ApiClientError);

    expect(registered.channelId).toBeTruthy();
  });

  it("revokes refresh after logout", async () => {
    const server = new MockLinkingServer();
    const registered = server.register(request());
    let refreshToken = "";

    server.subscribe(registered.channelId, (message) => {
      if (message.type === "tokens_issued") refreshToken = message.refreshToken;
    });

    server.scan({ token: "token-1", deviceId: "phone-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    server.logout({ channelId: registered.channelId, refreshToken });

    expect(() => server.refresh({ refreshToken })).toThrowError(ApiClientError);
  });

  it("pushes force logout", async () => {
    const server = new MockLinkingServer();
    const registered = server.register(request());
    let forced = false;

    server.subscribe(registered.channelId, (message) => {
      forced = message.type === "force_logout";
    });

    server.forceLogout(registered.channelId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(forced).toBe(true);
  });

  it("pushes phone offline and online status", async () => {
    const server = new MockLinkingServer();
    const registered = server.register(request());
    const states: boolean[] = [];

    server.subscribe(registered.channelId, (message) => {
      if (message.type === "phone_status") states.push(message.online);
    });

    server.setPhoneOnline(registered.channelId, false);
    server.setPhoneOnline(registered.channelId, true);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(states).toEqual([false, true]);
  });
});
