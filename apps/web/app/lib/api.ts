// HTTP layer for the Web client.
//
// Every call is routed to the LOCAL Next.js origin, never to the chat relay
// directly. API paths are prefixed with RELAY_PREFIX — the BFF proxies them to
// the chat relay ONLY after validating the HttpOnly web-session cookie against
// the backend (see app/api/relay/** and app/lib/relay-server.ts). Sending so
// the session cookie goes along is automatic (same-origin fetch).
export interface WptApiResult<T> {
  status: number;
  ok: boolean;
  body: T | null;
}

/**
 * Prefix that routes a relay API path (e.g. "/api/users") through the same-
 * origin BFF proxy. The old direct base (NEXT_PUBLIC_WPT_API_URL) is now a
 * SERVER-ONLY relay address (WPT_RELAY_URL); the browser never targets it.
 */
export const RELAY_PREFIX = "/api/relay";

export async function wptApi<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown> | null,
): Promise<WptApiResult<T>> {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" }, cache: "no-store" };
  if (body !== undefined && body !== null) init.body = JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(`${RELAY_PREFIX}${path}`, init);
  } catch {
    return { status: 0, ok: false, body: null };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, ok: res.ok, body: parsed as T };
}

/** Same-origin media URL (image/voice attachments), also behind the relay. */
export function relayMediaUrl(attachmentId: string): string {
  return `${RELAY_PREFIX}/api/media/${encodeURIComponent(attachmentId)}`;
}

/**
 * Non-relay BFF call (session/linking endpoints handled by Next route
 * handlers directly, e.g. /api/session/status — NOT forwarded to the chat
 * relay). Same-origin so the HttpOnly cookie travels along.
 */
export async function bffApi<T>(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown> | null,
): Promise<WptApiResult<T>> {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" }, cache: "no-store" };
  if (body !== undefined && body !== null) init.body = JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    return { status: 0, ok: false, body: null };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, ok: res.ok, body: parsed as T };
}