import { io, type Socket } from "socket.io-client";
import {
  SOCKET_NAMESPACE,
  SOCKET_TRANSPORT_PRIMARY,
  SOCKET_TRANSPORT_FALLBACK,
} from "@wpt/shared";

export interface RealtimeClientConfig {
  baseUrl: string;
  userId?: string;
  deviceId?: string;
  getAuthToken?: () => string | null | Promise<string | null>;
  /**
   * Short-lived Web-session ticket (Sprint 3). When set, it is used for the
   * socket handshake instead of a long-lived JWT — the Web client always talks
   * realtime through a ticket so no long-lived credential is ever placed in a
   * WebSocket URL or frame.
   */
  ticket?: string;
  /**
   * Short-lived LINK ticket, handed out by POST /web-link/register. It
   * authorises joining exactly one room — `link:<sha256(token)>` — and is the
   * mechanism by which the backend PUSHES the login hand-off to a browser that
   * has registered a token but has not yet been approved. Pre-authentication
   * only; it carries no account authority whatsoever.
   */
  linkTicket?: string;
}

/**
 * §7.3 — Primary transport: WebSocket. Falls back to long-polling automatically
 * if the websocket upgrade fails (relevant on free-tier hosts that don't
 * reliably support persistent connections under load) — this is
 * socket.io's built-in behavior, we just declare the transport order.
 *
 * Auth handshake includes userId + deviceId so the server can register
 * this socket in the registry and push force_logout to old devices.
 */
export async function createRealtimeClient(
  config: RealtimeClientConfig,
): Promise<Socket> {
  const token = config.ticket ?? config.linkTicket ?? (await config.getAuthToken?.());

  const auth: Record<string, string> = {};
  if (config.ticket) auth.ticket = String(config.ticket);
  if (config.linkTicket) auth.linkTicket = String(config.linkTicket);
  else if (token) auth.token = token;
  if (config.userId) auth.userId = config.userId;
  if (config.deviceId) auth.deviceId = config.deviceId;

  return io(config.baseUrl, {
    path: SOCKET_NAMESPACE,
    transports: [SOCKET_TRANSPORT_PRIMARY, SOCKET_TRANSPORT_FALLBACK],
    auth,
  });
}
