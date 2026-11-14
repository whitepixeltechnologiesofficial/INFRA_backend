// WEB session — Sprint 3.
//
// The web-session CREDENTIAL no longer lives here. It lives ONLY in the
// HttpOnly `wpt_web_session` cookie set/cleared by the Next BFF, so JavaScript
// never sees it and localStorage is out of the credential path entirely. This
// module persists just the display identity (userId + accountName) under the
// legacy key for continuity — the REAL source of truth is `GET
// /api/session/status`, where the BFF validates the cookie against the
// backend. Closing a tab clears nothing (the HttpOnly cookie survives, so the
// session still persists across tab close / browser restart as before) and
// there is deliberately NO beforeunload/pagehide/unload handler anywhere.
//
// The legacy storage key `wpt_web_session_v1` is retained for storage-layout
// continuity; blobs written by the pre-Sprint-3 client (which held a webToken
// credential) fail the v2 identity check and are ignored.
export const WEB_SESSION_KEY = "wpt_web_session_v1";
const SESSION_VERSION = 2;

export interface WebSession {
  userId: string;
  accountName: string;
}

interface WebSessionStored {
  v: number;
  userId: string;
  accountName: string;
}

export function saveWebSession(userId: string, accountName: string): void {
  try {
    const stored: WebSessionStored = { v: SESSION_VERSION, userId, accountName };
    window.localStorage.setItem(WEB_SESSION_KEY, JSON.stringify(stored));
  } catch (err) {
    console.warn("Web session identity could not be persisted.", err);
  }
}

export function loadWebSession(): WebSession | null {
  try {
    const raw = window.localStorage.getItem(WEB_SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Partial<WebSessionStored>;
    if (p.v === SESSION_VERSION && typeof p.userId === "string" && typeof p.accountName === "string") {
      return { userId: p.userId, accountName: p.accountName };
    }
    // Version mismatch — a legacy blob may still hold a webToken credential and
    // must never be reused as identity or a session.
    localStorage.removeItem(WEB_SESSION_KEY);
    return null;
  } catch (err) {
    console.warn("Web session identity could not be restored.", err);
    return null;
  }
}

// Clears the web session BOTH server-side (the BFF revokes and clears the
// HttpOnly cookie — the browser cannot delete an HttpOnly cookie itself) and
// from this identity cache. Idempotent; safe to call when the session is
// already gone. Exactly TWO call sites in the client: the manual Settings->
// Logout path and performSessionLogout (401 / webForceLoggedOut). Tab close
// never runs it (see above).
export async function clearWebSession(): Promise<void> {
  try {
    await fetch("/api/session/logout", { method: "POST", cache: "no-store" });
  } catch {
    // Network blip during logout — the server-side session would still be
    // revoked on its next poll; the local cache is cleared regardless.
  }
  try {
    window.localStorage.removeItem(WEB_SESSION_KEY);
  } catch (err) {
    console.warn("Web session identity could not be cleared.", err);
  }
}