// Server-only relay plumbing: browser chat HTTP requests (receive + send) are
// forwarded to the chat relay (wpt-server) ONLY when the Web session is valid
// against the backend. The session check is the same cookie -> Bearer bridge
// as the BFF session endpoints, with a short in-memory cache so chat traffic
// doesn't hammer the backend on every keystroke / poll.

import { webLinkApi } from "./web-link-server";

const STATUS_CACHE_TTL_MS = 15_000;
const STATUS_CACHE_MAX = 64;

interface CachedStatus {
  valid: boolean;
  userId: string | null;
  /** "ok" | "revoked" | "unreachable" — lets the proxy clear the cookie ONLY on real revocation. */
  state: "ok" | "revoked" | "unreachable";
  at: number;
}

const statusCache = new Map<string, CachedStatus>();

export function relayBaseUrl(): string {
  const raw = process.env.WPT_RELAY_URL || process.env.NEXT_PUBLIC_WPT_API_URL;
  return (raw && raw.trim() ? raw : "http://localhost:3001").replace(/\/+$/, "");
}

/** Backend-validates the HttpOnly web-session token (cached 15s). */
export async function checkWebSession(token: string): Promise<CachedStatus> {
  const now = Date.now();
  const cached = statusCache.get(token);
  if (cached && now - cached.at < STATUS_CACHE_TTL_MS) {
    return cached;
  }
  const base = { at: now };
  let status: CachedStatus = { valid: false, userId: null, state: "unreachable", ...base };
  try {
    const res = await webLinkApi(token).sessionStatus();
    status =
      res.ok === true
        ? { valid: true, userId: res.userId, state: "ok", ...base }
        : res.ok === false && res.error === "not_authorized"
          ? { valid: false, userId: null, state: "revoked", ...base }
          : { valid: false, userId: null, state: "unreachable", ...base };
  } catch {
    status = { valid: false, userId: null, state: "unreachable", ...base };
  }
  if (statusCache.size >= STATUS_CACHE_MAX) {
    for (const [k, v] of statusCache) {
      if (now - v.at > STATUS_CACHE_TTL_MS) statusCache.delete(k);
    }
  }
  statusCache.set(token, status);
  return status;
}