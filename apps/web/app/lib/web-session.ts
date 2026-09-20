// WEB session persistence. Lives in localStorage (never sessionStorage) so a
// closed tab / restarted browser resumes the same logged-in state with no
// re-scan (WEB-R1.5/1.7 tab-close persistence). There is deliberately NO
// beforeunload/pagehide/unload handler anywhere: closing a tab never clears it.
export const WEB_SESSION_KEY = "wpt_web_session_v1";

export interface WebSession {
  webToken: string;
  userId: string;
  savedAt: number;
}

export function saveWebSession(webToken: string, userId: string): void {
  try {
    window.localStorage.setItem(WEB_SESSION_KEY, JSON.stringify({ webToken, userId, savedAt: Date.now() } satisfies WebSession));
  } catch (err) {
    console.warn("Web session could not be persisted.", err);
  }
}

export function loadWebSession(): WebSession | null {
  try {
    const raw = window.localStorage.getItem(WEB_SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Partial<WebSession>;
    if (typeof p.webToken === "string" && typeof p.userId === "string") {
      return { webToken: p.webToken, userId: p.userId, savedAt: typeof p.savedAt === "number" ? p.savedAt : Date.now() };
    }
    return null;
  } catch (err) {
    console.warn("Web session could not be restored.", err);
    return null;
  }
}

// Exactly TWO call sites for this function exist in the client: the manual
// Settings->Logout path and performSessionLogout (401/webForceLoggedOut). Tab
// close never runs it (see above).
export function clearWebSession(): void {
  try {
    window.localStorage.removeItem(WEB_SESSION_KEY);
  } catch (err) {
    console.warn("Web session could not be cleared.", err);
  }
}