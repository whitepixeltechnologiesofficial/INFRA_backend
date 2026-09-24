/**
 * BE-5.5 — Realtime side-channel routes (read receipts + typing indicators).
 *
 * These endpoints speak the canonical Web wire contract unchanged
 * (packages/shared/realtime.ts: READ_ROUTE="/api/messages/read",
 * TYPING_ROUTE="/api/messages/typing"; the Web client helpers
 * buildReadRequest / announceTyping in apps/web/app/lib/buildReadRequest.ts
 * need no changes).
 *
 *   POST /api/messages/read    body: {from?, type:"direct"|"group", to|groupId, messageId}
 *     -> 200 {success, read, messageId} + realtime broadcast
 *        {type:"read", from, to|groupId, messageId, messageIds, at}
 *     400 bad_read | 403 not_member/from_mismatch | 404 read_not_found/user_not_found
 *   POST /api/messages/typing  body: {from?, type:"direct"|"group", to|groupId, typing}
 *     -> 200 {success, typing}
 *     400 bad_typing | 403 not_member/from_mismatch | 404 user_not_found
 *
 * The sender identity is derived from the JWT (`auth.sub`) — never trusted
 * from the body alone — so a caller cannot mark reads (or type) as another
 * user (matches OWASP API #1 used across the other backend routes). A body
 * `from` is accepted only when it equals the token subject.
 *
 * The server-side typing TTL comes from the canonical shared constant, with
 * an optional TYPING_TTL_MS env override (same knob as the WPT web server).
 */

import { Router, Request, Response } from "express";
import { TYPING_TTL_MS } from "@wpt/shared";
import { requireAuth } from "../middleware/auth.js";
import {
  applyRead,
  createTypingController,
  type ReadTarget,
  type RealtimeDeps,
  type TypingLookup,
} from "../messages/realtime.js";
import {
  broadcastRealtime,
  directThread,
  groupMembers,
  groupThread,
  userExists,
} from "../messages/providers.js";

const router: Router = Router();

router.use(requireAuth);

function typingTtlMs(): number {
  const env = Number(process.env.TYPING_TTL_MS);
  return Number.isFinite(env) && env > 0 ? env : TYPING_TTL_MS;
}

const typingController = createTypingController({ broadcast: broadcastRealtime }, typingTtlMs());

type ReadBody = {
  from?: string;
  type?: string;
  to?: string;
  groupId?: string;
  messageId?: string;
};

type TypingBody = {
  from?: string;
  type?: string;
  to?: string;
  groupId?: string;
  typing?: unknown;
};

function fromBody(res: Response, body: ReadBody | TypingBody): string | null {
  const auth = res.locals.auth!;
  const from = auth.sub;
  if (typeof body.from === "string" && body.from && body.from !== from) {
    return null;
  }
  return from;
}

function resolveTarget(body: ReadBody | TypingBody, from: string): ReadTarget {
  const isGroup = body.type === "group" || (body.type !== "direct" && Boolean(body.groupId) && !body.to);
  return isGroup
    ? { kind: "group", from, groupId: String(body.groupId ?? "") }
    : { kind: "direct", from, to: String(body.to ?? "") };
}

async function buildReadDeps(target: ReadTarget): Promise<RealtimeDeps> {
  const fromOk = Boolean(await Promise.resolve(userExists(target.from)));
  if (target.kind === "group") {
    const membersPromise = await Promise.resolve(groupMembers(target.groupId));
    const members = membersPromise === null ? null : membersPromise.map((m) => String(m));
    const thread = await Promise.resolve(groupThread(target.groupId));
    return {
      userExists: () => fromOk,
      groupMembers: () => members,
      directThread: () => [],
      groupThread: () => thread,
      broadcast: broadcastRealtime,
      now: () => new Date().toISOString(),
    };
  }
  const toOk = Boolean(await Promise.resolve(userExists(target.to)));
  const thread = await Promise.resolve(directThread(target.from, target.to));
  return {
    userExists: (id) => (id === target.from ? fromOk : id === target.to ? toOk : false),
    groupMembers: () => null,
    directThread: () => thread,
    groupThread: () => [],
    broadcast: broadcastRealtime,
    now: () => new Date().toISOString(),
  };
}

async function buildTypingLookup(target: ReadTarget): Promise<TypingLookup> {
  const fromOk = Boolean(await Promise.resolve(userExists(target.from)));
  if (target.kind === "group") {
    const membersPromise = await Promise.resolve(groupMembers(target.groupId));
    return {
      fromOk,
      members: membersPromise === null ? null : membersPromise.map((m) => String(m)),
    };
  }
  return { fromOk, toOk: Boolean(await Promise.resolve(userExists(target.to))) };
}

// ──────────────────────────────────────────────────
// POST /api/messages/read
// ──────────────────────────────────────────────────
router.post("/messages/read", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as ReadBody;
    const from = fromBody(res, body);
    if (from === null) {
      res.status(403).json({ error: "from_mismatch" });
      return;
    }

    const messageId =
      typeof body.messageId === "string" || typeof body.messageId === "number"
        ? String(body.messageId)
        : "";

    const target = resolveTarget(body, from);
    const deps = await buildReadDeps(target);
    const result = applyRead(deps, { target, messageId });

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ success: true, read: result.read, messageId: result.messageId });
  } catch (_err) {
    console.error("POST /api/messages/read error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────
// POST /api/messages/typing
// ──────────────────────────────────────────────────
router.post("/messages/typing", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as TypingBody;
    const from = fromBody(res, body);
    if (from === null) {
      res.status(403).json({ error: "from_mismatch" });
      return;
    }

    const typing = body.typing === true;
    const target = resolveTarget(body, from);
    const lookup = await buildTypingLookup(target);
    const result = typingController.typing({ target, typing }, lookup);

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ success: true, typing: result.typing });
  } catch (_err) {
    console.error("POST /api/messages/typing error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;