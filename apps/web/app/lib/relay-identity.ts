export const IDENTITY_POST_ROUTES: readonly string[] = [
  "/api/messages/send",
  "/api/messages/read",
  "/api/messages/typing",
];

export type BoundBody =
  | { ok: true; body: string }
  | { ok: false; error: "bad_json" | "from_mismatch"; status: 400 | 403 };

export type BoundPath =
  | { ok: true; segments: string[]; appendUserId: boolean }
  | { ok: false; error: "session_unbound"; status: 403 };

export function isIdentityPostRoute(route: string): boolean {
  return IDENTITY_POST_ROUTES.includes(route);
}

export function bindPostIdentity(route: string, raw: string, sessionUserId: string): BoundBody {
  if (!isIdentityPostRoute(route)) return { ok: true, body: raw };
  if (!sessionUserId) return { ok: false, error: "from_mismatch", status: 403 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "bad_json", status: 400 };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "bad_json", status: 400 };
  }
  const body = parsed as Record<string, unknown>;
  if (body.from !== undefined && body.from !== sessionUserId) {
    return { ok: false, error: "from_mismatch", status: 403 };
  }
  body.from = sessionUserId;
  return { ok: true, body: JSON.stringify(body) };
}

export function bindPathIdentity(route: string, sessionUserId: string): BoundPath {
  const segments = route.split("/").filter(Boolean);
  if (segments.length === 0) return { ok: true, segments, appendUserId: false };

  const isRecentChats = segments[0] === "api" && segments[1] === "recent-chats" && segments.length === 3;
  const isDirectHistory = segments[0] === "api" && segments[1] === "messages" && segments.length === 4;
  const isGroupHistory = segments[0] === "api" && segments[1] === "group-messages" && segments.length === 3;
  const isSyncedContacts = segments[0] === "api" && segments[1] === "synced-contacts" && segments.length === 2;
  const needsCaller = isRecentChats || isDirectHistory || isGroupHistory || isSyncedContacts;

  if (!needsCaller) return { ok: true, segments, appendUserId: false };
  if (!sessionUserId) return { ok: false, error: "session_unbound", status: 403 };

  if (isRecentChats || isDirectHistory) {
    const next = segments.slice();
    next[2] = sessionUserId;
    return { ok: true, segments: next, appendUserId: false };
  }
  return { ok: true, segments, appendUserId: true };
}

export function isRealtimeTicket(value: unknown): boolean {
  return typeof value === "string" && value.split(".").length === 3 && value.length > 0;
}
