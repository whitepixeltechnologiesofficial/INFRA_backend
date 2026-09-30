/**
 * §7.3 / §9.5 — Socket registry for force_logout push.
 *
 * Tracks which socket.io connections are live for each userId + deviceId
 * pair. After LOGIN-3.7's transaction commits, the registry is queried to
 * find all OTHER connected sockets for the same user, and a `force_logout`
 * event is pushed to each — causing the old device to end its session
 * locally with no advance warning (silent logout, ONB-1.7).
 *
 * The push IS the disconnect signal. No content, no warning message.
 */

import type { Server, Socket } from "socket.io";

export type SocketEntry = {
  socketId: string;
  deviceId: string;
};

// userId → Set of connected socket entries
const connections = new Map<string, Set<SocketEntry>>();

let ioRef: Server | null = null;

/** Called once from index.ts after io is created. */
export function initSocketRegistry(io: Server): void {
  ioRef = io;
}

/** Register a socket on connection. Expects userId + deviceId in handshake auth. */
export function registerSocket(socket: Socket, userId: string, deviceId: string): void {
  if (!connections.has(userId)) {
    connections.set(userId, new Set());
  }
  connections.get(userId)!.add({ socketId: socket.id, deviceId });
}

/** Unregister a socket on disconnect. */
export function unregisterSocket(socket: Socket, userId: string): void {
  const set = connections.get(userId);
  if (!set) return;

  for (const entry of set) {
    if (entry.socketId === socket.id) {
      set.delete(entry);
      break;
    }
  }

  if (set.size === 0) {
    connections.delete(userId);
  }
}

/**
 * §7.3 — Push force_logout to all connected sockets for a user,
 * EXCEPT the one identified by `excludeDeviceId` (the new login).
 *
 * Silent logout: the push event IS the disconnect signal.
 * No content, no warning — old devices end session immediately.
 *
 * Called by executeHandoffTransaction() after the DB transaction commits.
 */
export function pushForceLogout(userId: string, excludeDeviceId: string): void {
  if (!ioRef) {
    console.warn("pushForceLogout called before socket registry initialized");
    return;
  }

  const set = connections.get(userId);
  if (!set || set.size === 0) return;

  let pushed = 0;
  for (const entry of set) {
    if (entry.deviceId !== excludeDeviceId) {
      ioRef.to(entry.socketId).emit("force_logout");
      pushed++;
    }
  }

  if (pushed > 0) {
    console.log(`force_logout pushed to ${pushed} socket(s) for user ${userId}`);
  }
}

/** Debug: get connection count for a user. */
export function getConnectionCount(userId: string): number {
  return connections.get(userId)?.size ?? 0;
}

/**
 * BE-6.1 — Push force_logout to exactly ONE device.
 *
 * Unlike pushForceLogout() (which targets "everyone EXCEPT the new
 * device" for the §7.3 phone handoff), linking a new Web browser must
 * only ever kick the PREVIOUS Web browser — the phone and any other
 * devices are untouched. Same "the push IS the disconnect signal"
 * contract as pushForceLogout().
 */
export function pushForceLogoutToDevice(userId: string, deviceId: string): void {
  if (!ioRef) {
    console.warn("pushForceLogoutToDevice called before socket registry initialized");
    return;
  }

  const set = connections.get(userId);
  if (!set) return;

  for (const entry of set) {
    if (entry.deviceId === deviceId) {
      ioRef.to(entry.socketId).emit("force_logout");
    }
  }
}

/**
 * BE-6.1 — Actually close the live socket(s) for one device.
 *
 * Used by POST /linking/logoff, which must close Web's socket
 * server-side (not just notify it and hope it disconnects itself),
 * and by /linking/scan when kicking the previous Web browser.
 */
export function disconnectDevice(userId: string, deviceId: string): void {
  if (!ioRef) return;

  const set = connections.get(userId);
  if (!set) return;

  for (const entry of set) {
    if (entry.deviceId === deviceId) {
      ioRef.sockets.sockets.get(entry.socketId)?.disconnect(true);
    }
  }
}


/**
 * BE-5.4 — Push an event to the live socket(s) of exactly ONE device.
 *
 * Used by the message pipeline to deliver a relayed envelope in real time.
 * Returns true if at least one live socket was addressed. A `false` return
 * is NOT an error: the message is already durable in pending_messages and
 * the recipient will get it via POST /relay/poll on (re)connect.
 */
export function pushToDevice(
  userId: string,
  deviceId: string,
  event: string,
  payload: unknown,
): boolean {
  if (!ioRef) return false;

  const set = connections.get(userId);
  if (!set) return false;

  let pushed = false;
  for (const entry of set) {
    if (entry.deviceId === deviceId) {
      ioRef.to(entry.socketId).emit(event, payload);
      pushed = true;
    }
  }
  return pushed;
}
