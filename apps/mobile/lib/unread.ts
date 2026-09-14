// lib/unread.ts
//
// NOTIFICATIONS DENIED — IN-APP UNREAD ACCOUNTING (Scenario 3.4/3.5 denied,
// PRD §5.4, Tech Arch §14.x).
//
// When the Notifications OS permission is denied no push ever fires — the
// grant path's `registerPushOnGrant` returns `not_granted` and never registers
// a device token (see lib/push.ts). That does NOT mean the app goes quiet:
// unread state is still shown live in-app and the app must never silently fail
// to reflect unread messages it's capable of showing while it is open.
//
// This module owns that accounting as pure, dependency-free functions so the
// exact behavior (and its accuracy) can be verified in a Node harness:
//   - an incoming message on a chat the user is NOT currently viewing
//     increments that chat's unread count (the in-app indicator);
//   - an incoming message on the chat the user IS viewing adds nothing (you
//     are already reading it — nothing to badge);
//   - opening a chat clears its badge;
//   - totals are always derivable, so "indicator matches reality" holds.
//
// State is a plain map of chatId -> unread count; the UI layer decides when to
// persist/seed it. No OS notification, no push-token — purely the in-app path.

/** chatId -> unread message count. Absent/0 means "no badge". */
export type UnreadState = Record<string, number>;

/**
 * Record an incoming message against a chat. If the chat is already open the
 * user is reading it, so nothing is added — badging only what isn't in view.
 * Returns a new map; the input is never mutated.
 */
export function onIncomingMessage(unread: UnreadState, chatId: string, isChatOpen: boolean): UnreadState {
  if (isChatOpen) return unread;
  const next: UnreadState = { ...unread };
  next[chatId] = (next[chatId] ?? 0) + 1;
  return next;
}

/**
 * Record that a chat was opened/read — its badge clears. Returns a new map.
 */
export function onChatOpened(unread: UnreadState, chatId: string): UnreadState {
  if (unread[chatId] && unread[chatId] > 0) {
    const next: UnreadState = { ...unread };
    delete next[chatId];
    return next;
  }
  return unread;
}

/** Total unread across all chats (e.g. for a badge on a tab icon). */
export function totalUnread(unread: UnreadState): number {
  return Object.values(unread).reduce((sum, n) => sum + n, 0);
}

/** Whether a given chat has an unread badge. */
export function hasUnread(unread: UnreadState, chatId: string): boolean {
  return (unread[chatId] ?? 0) > 0;
}