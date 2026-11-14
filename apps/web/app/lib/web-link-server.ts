// Server-only WPT web-session + web-link plumbing for the Next.js BFF.
//
// This module runs ONLY in Next route handlers (node runtime). It owns:
//   - the HttpOnly session cookie (name/options/serialize) — the web session
//     credential NEVER touches JavaScript/localStorage;
//   - the backend base-url resolution;
//   - a tiny result mapping so handlers stay declarative.
//
// The Real Work is backend-authoritative: register/redeem/validate/approve/
// status/logout/ticket/devices all go through @wpt/api-client to apps/backend;
// this file only bridges the browser cookie and that backend contract.
//
// CONFIGURATION — one switch. `API_BASE_URL` is the single backend origin used
// by this BFF, and it is the only variable that decides mock vs real: pointing
// it at a mock or at apps/backend changes nothing else in the app, and no screen
// ever branches on which one it is. `NEXT_PUBLIC_API_BASE_URL` is the same
// origin made visible to the BROWSER, which needs it only to dial the realtime
// push channel directly; when it is absent the browser is handed `API_BASE_URL`,
// so a single variable is genuinely enough.

import { createWebLinkApi, type WebLinkApi } from "@wpt/api-client";
import { WEB_SESSION_MAX_AGE_MS, type WebLinkFailureResult } from "@wpt/shared";

export const WEB_SESSION_COOKIE = "wpt_web_session";

/**
 * The one switch. `API_BASE_URL` is the ONLY variable that decides mock vs real,
 * and the app has no second name for it: pointing it at a backend changes nothing
 * else and no screen branches on which one it is. Anything set to blank/unset
 * means "no linking service", which the gate surfaces as a retryable error.
 */
function backendBaseUrl(): string {
  const raw = process.env.API_BASE_URL;
  if (raw && raw.trim()) return raw.trim().replace(/\/+$/, "");
  throw new Error("API_BASE_URL is not configured");
}

export function isBackendConfigured(): boolean {
  return Boolean((process.env.API_BASE_URL || "").trim());
}

/**
 * The origin the BROWSER dials for the realtime push channel. Same backend, but
 * it has to be a value the page can see; the ticket it presents authorises one
 * link room and nothing else, so exposing the host grants nothing on its own.
 */
export function browserRealtimeBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_BASE_URL || backendBaseUrl();
  return raw.replace(/\/+$/, "");
}

export function webLinkApi(token?: string | null): WebLinkApi {
  return createWebLinkApi({
    baseUrl: backendBaseUrl(),
    getAuthToken: () => token ?? null,
  });
}

export function readCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === WEB_SESSION_COOKIE && value) return decodeURIComponent(value);
  }
  return null;
}

export function clearSessionCookie(): string {
  return `${WEB_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function setSessionCookie(sessionToken: string): string {
  const parts: string[] = [
    `${WEB_SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(WEB_SESSION_MAX_AGE_MS / 1000)}`,
  ];
  if (process.env.NODE_ENV === "production") {
    parts.splice(2, 0, "Secure");
  }
  return parts.join("; ");
}

// Map a confirmed failure (res.ok === false, already narrowed by callers) to
// an HTTP status + JSON body so handlers stay declarative.
export function failureResponse(res: WebLinkFailureResult): { httpStatus: number; body: object } {
  const status =
    res.error === "rate_limited" ? 429 : res.error === "not_authorized" ? 401 : res.error === "expired" || res.error === "already_used" ? 410 : 400;
  return { httpStatus: status, body: { ok: false, error: res.error, message: res.message, pending: res.error === "not_approved" } };
}