// Web chat UI state persistence (survives tab close / browser restart).
export const APP_STATE_KEY = "wpt_web_app_state_v1";

export interface WebChatMessage {
  id: string;
  from: string;
  text: string;
  time: string;
  tmp?: boolean;
}

export interface WebChatItem {
  id: string;
  serverId: string | null;
  name: string;
  initials: string;
  avatarBg: string;
  preview: string;
  time: string;
  unread: number;
  online: boolean;
  isGroup: boolean;
}

export interface WebAppStateV1 {
  recentChats: WebChatItem[];
  chatHistory: Record<string, WebChatMessage[]>;
  activeChatId: string | null;
  savedAt: number;
}

export function defaultAppState(): WebAppStateV1 {
  return { recentChats: [], chatHistory: {}, activeChatId: null, savedAt: Date.now() };
}

export function saveAppState(state: WebAppStateV1): void {
  try {
    window.localStorage.setItem(APP_STATE_KEY, JSON.stringify({ ...state, savedAt: Date.now() }));
  } catch (err) {
    console.warn("Web chat state could not be persisted.", err);
  }
}

export function restoreAppState(): WebAppStateV1 {
  const fallback = defaultAppState();
  try {
    const raw = window.localStorage.getItem(APP_STATE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    const p = parsed as Partial<WebAppStateV1>;
    return {
      recentChats: Array.isArray(p.recentChats) ? (p.recentChats as WebChatItem[]) : [],
      chatHistory: p.chatHistory && typeof p.chatHistory === "object" ? (p.chatHistory as Record<string, WebChatMessage[]>) : {},
      activeChatId: typeof p.activeChatId === "string" ? p.activeChatId : null,
      savedAt: Date.now(),
    };
  } catch (err) {
    console.warn("Web chat state could not be restored.", err);
    return fallback;
  }
}

export function clearAppState(): void {
  try {
    window.localStorage.removeItem(APP_STATE_KEY);
  } catch (err) {
    console.warn("Web chat state could not be cleared.", err);
  }
}

export function clearAppStateStorage(): void {
  clearAppState();
}