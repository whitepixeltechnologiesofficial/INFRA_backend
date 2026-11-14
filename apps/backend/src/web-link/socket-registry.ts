// Web-socket registry — the two realtime concerns the Web needs, on the ONE
// existing socket.io server (apps/backend, namespace SOCKET_NAMESPACE).
//
//   1. LINK REGISTRATIONS (pre-authentication). A browser that has just
//      registered a linking token presents a short-lived `linkTicket` and joins
//      exactly one room, `link:<sha256(token)>`. When the phone approves, the
//      backend PUSHES the login hand-off to that room. This is what removes
//      polling from the linking flow. It is re-joined on every reconnect, and a
//      still-unspent login is re-emitted on reconnect by the caller.
//
//   2. WEB SESSIONS (post-authentication). A browser with a live session
//      presents a `ticket` and is tracked here so revocation paths (one-browser
//      replacement, new-phone login, device revoke, logout) can push the
//      reason-aware `webForceLoggedOut` event in real time.
//
// The backend STILL enforces revocation server-side on the next request — the
// push is the prompt, not the guarantee.

import { WEB_LINK_EVENTS } from "@wpt/shared";
import type { Server, Socket } from "socket.io";

type WebSocketEntry = {
  socketId: string;
  deviceId: string;
  webSessionId: string;
};

// userId → Set of web session socket entries
const webSockets = new Map<string, Set<WebSocketEntry>>();
// linkId (token hash) → Set of pre-auth socket ids
const linkSockets = new Map<string, Set<string>>();

let ioRef: Server | null = null;

export function initWebSocketRegistry(io: Server): void {
  ioRef = io;
}

export function registerWebSocket(
  socket: Socket,
  userId: string,
  deviceId: string,
  webSessionId: string,
): void {
  if (!webSockets.has(userId)) webSockets.set(userId, new Set());
  webSockets.get(userId)!.add({ socketId: socket.id, deviceId, webSessionId });
  socket.join(`user:${userId}`);
  socket.join(`webSession:${webSessionId}`);
}

export function unregisterWebSocket(socket: Socket, userId: string): void {
  const set = webSockets.get(userId);
  if (!set) return;
  for (const entry of set) {
    if (entry.socketId === socket.id) {
      set.delete(entry);
      break;
    }
  }
  if (set.size === 0) webSockets.delete(userId);
}

/**
 * Register a pre-auth link socket. Called only after `verifyLinkTicket`, so the
 * caller is already proven to own `linkId`.
 */
export function registerLinkSocket(socket: Socket, linkId: string): void {
  let set = linkSockets.get(linkId);
  if (!set) {
    set = new Set();
    linkSockets.set(linkId, set);
  }
  set.add(socket.id);
  socket.join(`link:${linkId}`);
}

export function unregisterLinkSocket(socket: Socket, linkId: string): void {
  const set = linkSockets.get(linkId);
  if (!set) return;
  set.delete(socket.id);
  if (set.size === 0) linkSockets.delete(linkId);
}

export function isLinkSocketConnected(linkId: string): boolean {
  return (linkSockets.get(linkId)?.size ?? 0) > 0;
}

/**
 * Push the login hand-off to the browser that owns this link. This is the
 * server-push that replaces "are you logged in yet?" polling.
 */
export function emitWebLinkLogin(
  linkId: string,
  payload: { code: string; expiresAt: string; linkExpiresAt: string },
): void {
  if (!ioRef) return;
  ioRef.to(`link:${linkId}`).emit(WEB_LINK_EVENTS.login, payload);
}

/** Confirm to the phone (and any observer) that the link is now approved. */
export function emitWebLinkApproved(linkId: string): void {
  if (!ioRef) return;
  ioRef.to(`link:${linkId}`).emit(WEB_LINK_EVENTS.approved, { ok: true });
}

/**
 * Emit `webForceLoggedOut` to EVERY live Web socket of a user, by userId rather
 * than by session. Notice text is reason-aware.
 *
 * R1.9 SCOPE, not R1.8: "no grace period" belongs to the R1.9 new-phone force
 * logout. R1.8's revocation push is `emitWebSessionTerminated` below, which
 * targets the one session being revoked.
 *
 * Still no caller, and deliberately so. R1.9's sweep used to have no per-session
 * id to address, which is what made an account-wide fan-out look necessary; now
 * that it is one atomic store call, `revokeAllActiveSessions` returns exactly the
 * rows it ended, so the sweep notifies each session it actually revoked and no
 * others. Address-by-user would be strictly worse here: it reaches every socket
 * the account currently holds, which after a concurrent browser replacement can
 * include a session the sweep did not revoke, telling a browser to drop a
 * credential the server never ended. Kept for a caller that must disconnect an
 * account without revoking sessions (e.g. an admin account-wide disconnect),
 * which is a different decision from R1.9's.
 */
export function emitWebForceLoggedOut(userId: string, reason: string): void {
  if (!ioRef) {
    console.warn("emitWebForceLoggedOut called before web socket registry initialized");
    return;
  }
  const set = webSockets.get(userId);
  if (!set || set.size === 0) return;
  for (const entry of set) {
    ioRef.to(entry.socketId).emit(WEB_LINK_EVENTS.forceLoggedOut, { reason });
  }
}

/**
 * R1.8 — revoke ONE Web session's sockets. This is the push that accompanies
 * every live revocation: `logout` ("logged_out"), the mobile device revoke
 * ("device_revoked"), the R1.6 browser replacement ("replaced_by_new_browser")
 * and the R1.9 force logout (its `reason`).
 *
 * The push is the PROMPT, never the guarantee. R1.8's authority is the server:
 * `requireWebSession` re-reads the session and refuses a revoked credential on
 * the next request, so a browser that ignores or never receives this event is
 * already dead at the backend. This emit only exists so a well-behaved client
 * stops promptly instead of waiting to discover it on its next call.
 *
 * It addresses the per-session room rather than `user:<userId>` so that
 * revoking one browser cannot disturb a sibling browser or the account's phone.
 */
export function emitWebSessionTerminated(webSessionId: string, reason: string): void {
  if (!ioRef) return;
  ioRef.to(`webSession:${webSessionId}`).emit(WEB_LINK_EVENTS.forceLoggedOut, { reason });
}

export function getWebSocketCount(userId: string): number {
  return webSockets.get(userId)?.size ?? 0;
}

export function getLinkSocketCount(linkId: string): number {
  return linkSockets.get(linkId)?.size ?? 0;
}

/** Test hook. */
export function resetWebSocketRegistry(): void {
  webSockets.clear();
  linkSockets.clear();
}
