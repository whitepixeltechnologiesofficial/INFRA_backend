/**
 * BE-5.5 — Provider bottle for the realtime side-channel.
 *
 * The Express routes in ./messages.ts call these seams instead of coupling to
 * the DB or socket.io directly, so verification harnesses can inject
 * deterministic stubs (overrideProviders) and the live backend can supply real
 * lookups. Defaults:
 *
 *   - userExists / groupMembers   — read from the DB (async, lazy import)
 *   - direct/group thread history — empty today: the backend only stores
 *     per-device E2E-ciphered relay rows, so the sender's logical web message
 *     ids cannot be enumerated server-side. BE-5.5 therefore broadcasts the
 *     furthest `messageId` (which the existing Web client handler already
 *     accepts as a single-id read-through). Plug the plaintext thread source
 *     here when one exists to restore full messageIds resolution.
 *   - broadcast                    — socket.io `realtime` channel to each room
 *     (dm:/group:/user:), room names matching the WPT web server contract.
 *
 * Erasable-only TypeScript: harnesses import it directly via tsx.
 */
import type { Server } from "socket.io";
import { eq } from "drizzle-orm";
import type { ThreadMessage } from "./realtime.js";

let ioRef: Server | null = null;

/** Register the socket.io server (called once from index.ts). */
export function bindIo(io: Server | null): void {
  ioRef = io;
}

export function getIo(): Server | null {
  return ioRef;
}

export interface ProviderOverrides {
  userExists?: (id: string) => boolean | Promise<boolean>;
  groupMembers?: (groupId: string) => string[] | null | Promise<string[] | null>;
  directThread?: (a: string, b: string) => readonly ThreadMessage[] | Promise<readonly ThreadMessage[]>;
  groupThread?: (groupId: string) => readonly ThreadMessage[] | Promise<readonly ThreadMessage[]>;
}

async function dbUserExists(id: string): Promise<boolean> {
  const { getDb } = await import("../db/index.js");
  const { users } = await import("../db/users-schema.js");
  const rows = await getDb().select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
  return rows.length === 1;
}

async function dbGroupMembers(groupId: string): Promise<string[] | null> {
  const { getDb } = await import("../db/index.js");
  const { groupMembers } = await import("../db/groups-schema.js");
  const rows = await getDb().select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, groupId));
  return rows.map((r) => String(r.userId));
}

function emptyThread(): readonly ThreadMessage[] {
  return [];
}

const defaults: Required<ProviderOverrides> = {
  userExists: dbUserExists,
  groupMembers: dbGroupMembers,
  directThread: emptyThread,
  groupThread: emptyThread,
};

let overrides: Partial<Required<ProviderOverrides>> = {};

/** Inject deterministic stubs for tests. Merge semantics; resetProviders() restores defaults. */
export function overrideProviders(p: ProviderOverrides): void {
  overrides = { ...overrides, ...p };
}

export function resetProviders(): void {
  overrides = {};
}

export function userExists(id: string): boolean | Promise<boolean> {
  return (overrides.userExists ?? defaults.userExists)(id);
}

export function groupMembers(groupId: string): string[] | null | Promise<string[] | null> {
  return (overrides.groupMembers ?? defaults.groupMembers)(groupId);
}

export function directThread(a: string, b: string): readonly ThreadMessage[] | Promise<readonly ThreadMessage[]> {
  return (overrides.directThread ?? defaults.directThread)(a, b);
}

export function groupThread(groupId: string): readonly ThreadMessage[] | Promise<readonly ThreadMessage[]> {
  return (overrides.groupThread ?? defaults.groupThread)(groupId);
}

/** Deliver a side-channel payload to socket.io rooms (`realtime` channel). */
export function broadcastRealtime(rooms: readonly string[], payload: unknown): void {
  const io = ioRef;
  if (!io) return;
  for (const room of rooms) io.to(room).emit("realtime", payload);
}