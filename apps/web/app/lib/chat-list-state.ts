// WEB-2.1 — chat list / chat window state is a first-class, designed surface.
//
// The Phase-5 design renders three distinct chat-list states and two distinct
// chat-window states. They are a real part of the product, not an afterthought:
// an account with no conversations must get a *designed* screen (mark, heading,
// explanatory copy, and a call to action) rather than a blank pane, and that
// empty state must never be confused with "your search matched nothing".
//
// This module owns that decision so it can be proven without a browser. It is
// pure, dependency-free and erasable-only (no enums / parameter properties /
// namespaces) so the Node harnesses import it directly with type stripping,
// exactly like ./receipts.ts, ./search.ts and ./synced-contacts.ts.
//
// The component tree in ../wpt/chat-app.tsx consumes these results; nothing
// here fetches, mutates or invents data. The caller supplies the rows that the
// real `/api/recent-chats/{uid}` endpoint returned.

/**
 * The only shape the search touches. Kept structural and minimal on purpose so
 * this module stays dependency-free and works with the real `WebChatItem`
 * (declared in ./app-state.ts) without re-declaring a rival row type that could
 * drift from it.
 */
export interface SearchableChat {
  name: string;
  preview: string;
}

/**
 * `empty`     - the account genuinely has no conversations yet.
 * `no-matches`- there are conversations, but the sidebar search excluded them all.
 * `populated` - there is at least one row to render.
 */
export type ChatListState = "empty" | "no-matches" | "populated";

/** `no-selection` - no chat is open; the window shows its designed rest state. */
export type ChatWindowState = "no-selection" | "conversation";

/** Copy is exported so the harnesses can assert the designed screen, not just a class name. */
export const CHAT_LIST_EMPTY_TITLE = "No chats yet";
export const CHAT_LIST_EMPTY_COPY =
  "Start a conversation with someone on Sealine. Chats you send and receive land here.";
export const CHAT_LIST_NO_MATCHES_COPY = "No chats match your search.";

export const CHAT_WINDOW_EMPTY_TITLE = "Pick a conversation";

/**
 * Sidebar search: case-insensitive match on the visible name or the message
 * preview. An empty/whitespace query is "no filter" and returns every row, so a
 * blank search box can never make a populated account look empty.
 */
export function filterChats<T extends SearchableChat>(chats: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...chats];
  return chats.filter((c) => c.name.toLowerCase().includes(needle) || c.preview.toLowerCase().includes(needle));
}

/**
 * The zero-chats test is deliberately made on the *unfiltered* list: an account
 * with no conversations shows the designed empty screen even if a stale search
 * box holds text, and a populated account never falls back to it.
 */
export function decideChatListState<T extends SearchableChat>(chats: readonly T[], query: string): ChatListState {
  if (chats.length === 0) return "empty";
  return filterChats(chats, query).length === 0 ? "no-matches" : "populated";
}

/** The chat window is empty only when no conversation is selected. */
export function decideChatWindowState(activeChatId: string | null | undefined): ChatWindowState {
  return activeChatId ? "conversation" : "no-selection";
}

/** The offered actions on the designed empty screens — a rest state, never a dead pane. */
export interface EmptyStateSurface {
  state: ChatListState | ChatWindowState;
  hasMark: boolean;
  title: string;
  copy: string;
  hasCallToAction: boolean;
}

/**
 * Describes the designed surface a rest state must render. `hasMark` and
 * `hasCallToAction` are what separate a designed screen from a blank one, and
 * are asserted by the WEB-2.1 harness for every rest state.
 */
export function emptyStateSurface(state: ChatListState | ChatWindowState): EmptyStateSurface | null {
  if (state === "empty") {
    return { state, hasMark: true, title: CHAT_LIST_EMPTY_TITLE, copy: CHAT_LIST_EMPTY_COPY, hasCallToAction: true };
  }
  if (state === "no-matches") {
    return { state, hasMark: false, title: CHAT_LIST_NO_MATCHES_COPY, copy: "", hasCallToAction: false };
  }
  if (state === "no-selection") {
    return { state, hasMark: true, title: CHAT_WINDOW_EMPTY_TITLE, copy: "", hasCallToAction: true };
  }
  return null;
}

/** A rest state is only acceptable if it is actually designed. */
export function isDesignedRestState(surface: EmptyStateSurface | null): boolean {
  if (!surface) return false;
  if (surface.hasCallToAction) return surface.hasMark && surface.title.length > 0;
  return surface.title.length > 0;
}
