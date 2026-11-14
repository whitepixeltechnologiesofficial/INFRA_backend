import { useSyncExternalStore } from 'react';

export type UnreadState = Record<string, number>;

let state: UnreadState = {};
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export const unreadStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot() {
    return state;
  },
  onIncomingMessage(chatId: string, isOpen: boolean) {
    if (isOpen) return;
    state = {
      ...state,
      [chatId]: (state[chatId] || 0) + 1,
    };
    notify();
  },
  onChatOpened(chatId: string) {
    if (state[chatId]) {
      state = { ...state };
      delete state[chatId];
      notify();
    }
  },
  getTotalUnread(): number {
    return Object.values(state).reduce((sum, count) => sum + count, 0);
  },
  reset() {
    state = {};
    notify();
  },
};

/**
 * PERM-2.6 — ids of incoming messages not counted yet. Each incoming message
 * is counted exactly once, however many times its thread is re-rendered or
 * re-stamped (delivered/read), so badges never over-count.
 */
export function takeNewIncoming(
  messages: readonly { id: string; sent: boolean }[],
  seen: Set<string>,
): string[] {
  const fresh: string[] = [];
  for (const m of messages) {
    if (m.sent || seen.has(m.id)) continue;
    seen.add(m.id);
    fresh.push(m.id);
  }
  return fresh;
}

export function useUnreadCount(chatId: string): number {
  const s = useSyncExternalStore(unreadStore.subscribe, unreadStore.getSnapshot);
  return s[chatId] || 0;
}

export function useTotalUnreadCount(): number {
  const s = useSyncExternalStore(unreadStore.subscribe, unreadStore.getSnapshot);
  return Object.values(s).reduce((sum, count) => sum + count, 0);
}
