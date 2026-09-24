/**
 * BE-5.5 — Realtime side-channel core (read receipts + typing indicators).
 *
 * The canonical Web wire contract (packages/shared/realtime.ts + the Web
 * client helpers in apps/web/app/lib/receipts.ts) is:
 *
 *   POST /api/messages/read    {from, type:"direct"|"group", to|groupId, messageId}
 *     -> broadcast {type:"read", from, to|groupId, messageId, messageIds, at}
 *        to dm/group + member user rooms
 *   POST /api/messages/typing  {from, type:"direct"|"group", to|groupId, typing}
 *     -> broadcast {type:"typing", from, typing, kind, to|groupId, at}
 *        on/off, with a server TTL that auto-cleans a quiet typist
 *
 * This module is the pure, dependency-free implementation of those semantics.
 * Everything external (user/group lookup, thread history, socket delivery) is
 * injected so the whole contract is Node-verifiable without a database or a
 * socket. The Express adapter in routes/messages.ts wires it to the real
 * backend (JWT auth + socket.io user rooms).
 *
 * Erasable-only TypeScript: harnesses import it directly via tsx.
 */
import { TYPING_TTL_MS } from "@wpt/shared";

export type ReadTarget =
  | { kind: "direct"; from: string; to: string }
  | { kind: "group"; from: string; groupId: string };

export interface ReadInput {
  target: ReadTarget;
  messageId: string;
}

export interface TypingInput {
  target: ReadTarget;
  typing: boolean;
}

export interface ThreadMessage {
  id: string;
  from: string;
}

export interface ReadBroadcast {
  type: "read";
  from: string;
  to?: string;
  groupId?: string;
  messageId: string;
  messageIds: string[];
  at: string;
}

export interface TypingBroadcast {
  type: "typing";
  from: string;
  typing: boolean;
  kind: "direct" | "group";
  to?: string;
  groupId?: string;
  at: string;
}

export interface RealtimeDeps {
  /** False when the id is not a known user (drives user_not_found / bad_read). */
  userExists: (id: string) => boolean;
  /** Member ids of a group, or null when the group does not exist. */
  groupMembers: (groupId: string) => string[] | null;
  /** Direct-chat thread history (peer-authored rows unfiltered). */
  directThread: (a: string, b: string) => readonly ThreadMessage[];
  /** Group-chat thread history (member-authored rows unfiltered). */
  groupThread: (groupId: string) => readonly ThreadMessage[];
  /** Socket delivery. Room names mirror the WPT web server: dm:, group:, user:. */
  broadcast: (rooms: readonly string[], payload: unknown) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

export type ReadResult =
  | { ok: true; read: number; messageId: string; payload: ReadBroadcast; rooms: string[] }
  | { ok: false; status: 400 | 403 | 404; error: string; message?: string };

export type TypingResult =
  | { ok: true; typing: boolean; payloads: { payload: TypingBroadcast; rooms: string[] }[] }
  | { ok: false; status: 400 | 403 | 404; error: string; message?: string };

export function directKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

export function groupKey(gid: string): string {
  return `group:${gid}`;
}

/**
 * Resolve the read-through: every thread message up to and including
 * `messageId` that the reporter did not write themselves.
 *
 * Direct chats: the peer is the author of the messages the reporter has read
 * (m.from === to). Groups: any other member's message (m.from !== from).
 */
export function resolveReadThrough(
  thread: readonly ThreadMessage[],
  readerId: string,
  messageId: string,
  peerOnly: boolean,
  peerId?: string,
): { index: number; ids: string[] } {
  let idx = -1;
  let i = 0;
  for (const m of thread) {
    if (String(m.id) === messageId) {
      idx = i;
      break;
    }
    i += 1;
  }
  if (idx === -1) return { index: -1, ids: [] };
  const ids: string[] = [];
  for (const m of thread.slice(0, idx + 1)) {
    if (peerOnly) {
      if (m.from === peerId) ids.push(String(m.id));
    } else if (m.from !== readerId) {
      ids.push(String(m.id));
    }
  }
  return { index: idx, ids };
}

/**
 * Read-receipt writer. The reporter `from` marks everything up to `messageId`
 * as read and the server broadcasts who-read-what to the chat + users.
 */
export function applyRead(deps: RealtimeDeps, input: ReadInput): ReadResult {
  const at = deps.now ? deps.now() : new Date().toISOString();
  const { target } = input;
  const mid = input.messageId;

  if (!deps.userExists(target.from)) {
    return { ok: false, status: 400, error: "bad_read" };
  }
  if (!mid) {
    return { ok: false, status: 400, error: "bad_read", message: "messageId is required." };
  }

  if (target.kind === "group") {
    const members = deps.groupMembers(target.groupId);
    if (!members) {
      return { ok: false, status: 403, error: "not_member" };
    }
    if (!members.includes(target.from)) {
      return { ok: false, status: 403, error: "not_member" };
    }
    const thread = deps.groupThread(target.groupId);
    const { ids } = resolveReadThrough(thread, target.from, mid, false);
    if (ids.length === 0 && !thread.some((m) => String(m.id) === mid)) {
      return { ok: false, status: 404, error: "read_not_found" };
    }
    const payload: ReadBroadcast = { type: "read", from: target.from, groupId: target.groupId, messageId: mid, messageIds: ids, at };
    const rooms = [`${groupKey(target.groupId)}`, ...members.map((uid) => `user:${uid}`)];
    deps.broadcast(rooms, payload);
    return { ok: true, read: ids.length, messageId: mid, payload, rooms };
  }

  if (!deps.userExists(target.to)) {
    return { ok: false, status: 404, error: "user_not_found" };
  }
  const thread = deps.directThread(target.from, target.to);
  const { index, ids } = resolveReadThrough(thread, target.from, mid, true, target.to);
  if (index === -1) {
    return { ok: false, status: 404, error: "read_not_found" };
  }
  const payload: ReadBroadcast = { type: "read", from: target.from, to: target.to, messageId: mid, messageIds: ids, at };
  const rooms = [`dm:${directKey(target.from, target.to)}`, `user:${target.from}`, `user:${target.to}`];
  deps.broadcast(rooms, payload);
  return { ok: true, read: ids.length, messageId: mid, payload, rooms };
}

export interface TypingLookup {
  /** Whether the typist (`from`) is a known user. */
  fromOk: boolean;
  /** Whether the direct-chat peer is a known user (omitted for groups). */
  toOk?: boolean;
  /** Group members, or null when the group does not exist (groups only). */
  members?: string[] | null;
}

export interface TypingControllerOpts {
  broadcast: (rooms: readonly string[], payload: unknown) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

/**
 * Server-wide typing controller. Timers live here (cross-request), while
 * per-request identity/membership is passed in via TypingLookup. Semantics
 * match the WPT web server: typing:true re-arms the TTL; a quiet typist is
 * auto-cleared by broadcasting typing:false; an explicit typing:false with no
 * active timer is a no-op.
 */
export function createTypingController(opts: TypingControllerOpts, ttlMs = TYPING_TTL_MS) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const now = opts.now ?? (() => new Date().toISOString());

  function clearTimer(key: string): void {
    const t = timers.get(key);
    if (t) {
      clearTimeout(t);
      timers.delete(key);
    }
  }

  function announce(payload: TypingBroadcast, rooms: string[]): void {
    opts.broadcast(rooms, payload);
  }

  function typing(input: TypingInput, lookup: TypingLookup): TypingResult {
    const at = now();
    const { target } = input;
    const isTyping = input.typing === true;

    if (!lookup.fromOk) {
      return { ok: false, status: 400, error: "bad_typing" };
    }

    if (target.kind === "group") {
      const members = lookup.members ?? [];
      if (!members || !members.includes(target.from)) {
        return { ok: false, status: 403, error: "not_member" };
      }
      const chatKey = `${groupKey(target.groupId)}:${target.from}`;
      const rooms = [`${groupKey(target.groupId)}`, ...members.map((uid) => `user:${uid}`)];
      if (isTyping) {
        const payload: TypingBroadcast = { type: "typing", from: target.from, typing: true, kind: "group", groupId: target.groupId, at };
        announce(payload, rooms);
        clearTimer(chatKey);
        timers.set(chatKey, setTimeout(() => {
          timers.delete(chatKey);
          announce({ type: "typing", from: target.from, typing: false, kind: "group", groupId: target.groupId, at: now() }, rooms);
        }, ttlMs));
        return { ok: true, typing: true, payloads: [{ payload, rooms }] };
      }
      if (timers.has(chatKey)) {
        clearTimer(chatKey);
        const payload: TypingBroadcast = { type: "typing", from: target.from, typing: false, kind: "group", groupId: target.groupId, at };
        announce(payload, rooms);
        return { ok: true, typing: false, payloads: [{ payload, rooms }] };
      }
      return { ok: true, typing: false, payloads: [] };
    }

    if (lookup.toOk === false) {
      return { ok: false, status: 404, error: "user_not_found" };
    }
    const chatKey = `${directKey(target.from, target.to)}:${target.from}`;
    const rooms = [`dm:${directKey(target.from, target.to)}`, `user:${target.from}`, `user:${target.to}`];
    if (isTyping) {
      const payload: TypingBroadcast = { type: "typing", from: target.from, typing: true, kind: "direct", to: target.to, at };
      announce(payload, rooms);
      clearTimer(chatKey);
      timers.set(chatKey, setTimeout(() => {
        timers.delete(chatKey);
        announce({ type: "typing", from: target.from, typing: false, kind: "direct", to: target.to, at: now() }, rooms);
      }, ttlMs));
      return { ok: true, typing: true, payloads: [{ payload, rooms }] };
    }
    if (timers.has(chatKey)) {
      clearTimer(chatKey);
      const payload: TypingBroadcast = { type: "typing", from: target.from, typing: false, kind: "direct", to: target.to, at };
      announce(payload, rooms);
      return { ok: true, typing: false, payloads: [{ payload, rooms }] };
    }
    return { ok: true, typing: false, payloads: [] };
  }

  return {
    typing,
    clearTimer,
    hasTimer: (key: string) => timers.has(key),
    dispose: () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}