// The Web client's chat DATA LAYER.
//
// Every conversation row and every message the UI shows arrives through
// `ChatSource`. There is exactly one interface here on purpose:
//
//     UI  ->  ChatSource  ->  relayChatSource   (what ships)
//                            -> fixtureChatSource (development only)
//
// The components never learn which source served them, and both sources speak
// the SAME wire shapes the chat relay already speaks (`ServerChatSummaryItem` /
// `ServerSentMessage`), so replacing fixtures with real data is a change to
// `resolveChatSource()` alone. Nothing in ../wpt/*.tsx has to be rewritten.
//
// Unread handling is the one field worth reading closely. The relay has no
// unread concept at all - the Web client derives unread purely from live
// inbound socket events - so `unread` is OPTIONAL and the relay never sets it.
// A source that already knows the unread count ahead of time (the development
// fixtures) may set it. In web-app.tsx the merge keeps a locally accumulated
// count when it has one and only falls back to the source's value the first
// time a row is seen, so production behaviour is byte-for-byte unchanged.

import { wptApi } from "./api";
import { chatFixturesEnabled } from "./chat-fixtures-gate";
import type { ServerChatSummaryItem, ServerSentMessage } from "../wpt/types";
import type { WebChatItem } from "./app-state";

/** One row of the chat list. Structurally a relay summary plus optional unread. */
export interface ChatSummaryRow extends ServerChatSummaryItem {
  /**
   * Initial unread count, seeded once when the row is first observed.
   *
   * Optional and deliberately NOT part of the relay contract: `ServerChatSummaryItem`
   * is unchanged, the relay never sends it, and an absent value means 0 exactly
   * as before. Only a data source that knows unread up front supplies it.
   */
  unread?: number;
}

export interface ChatSource {
  /** Identifies the provider. Surfaced for diagnostics/tests, never rendered. */
  readonly kind: "relay" | "fixtures";
  /** Conversation rows for the signed-in account, or null when unavailable. */
  listChats(uid: string): Promise<ChatSummaryRow[] | null>;
  /** Full history for one conversation, or null when unavailable. */
  loadHistory(uid: string, chat: WebChatItem): Promise<ServerSentMessage[] | null>;
  /**
   * Optional live-state seed keyed by chat id (WEB-2.3 typing row). The relay
   * derives typing purely from socket events, so it leaves this undefined; a
   * fixture source may pre-seed it so the typing indicator is reachable with no
   * chat backend running.
   */
  readonly initialTyping?: Record<string, boolean>;
}

/** The conversation key the relay addresses a chat by. */
export function chatKey(chat: Pick<WebChatItem, "id" | "serverId">): string {
  return chat.serverId || chat.id;
}

/**
 * The production data source: the chat relay, reached through the same-origin
 * BFF. Behaviour is identical to the calls this layer used to make inline.
 */
export const relayChatSource: ChatSource = {
  kind: "relay",
  async listChats(uid) {
    const r = await wptApi<{ items: ServerChatSummaryItem[] }>("GET", `/api/recent-chats/${encodeURIComponent(uid)}`);
    if (!r.ok || !r.body || !Array.isArray(r.body.items)) return null;
    return r.body.items;
  },
  async loadHistory(uid, chat) {
    const key = chatKey(chat);
    if (!key) return null;
    const path = chat.isGroup
      ? `/api/group-messages/${encodeURIComponent(key)}`
      : `/api/messages/${encodeURIComponent(uid)}/${encodeURIComponent(key)}`;
    const r = await wptApi<ServerSentMessage[]>("GET", path);
    if (!r.ok || !Array.isArray(r.body)) return null;
    return r.body;
  },
};

let fixtureSource: ChatSource | null = null;

/**
 * Resolve the data source once per page load.
 *
 * `DEV_ENV` deliberately reads `process.env.NODE_ENV` directly at this call
 * site. Next replaces that expression with a literal ("development" for
 * `next dev`, "production" for `next build`/`next start`), so in a production
 * bundle `DEV_ENV` folds to the constant `false` and the bundler drops the rest
 * of this function - including the `import()` below - rather than shipping the
 * sample conversations in a chunk that could never run. The guard is therefore
 * both a runtime gate AND a build-time one.
 *
 * `chatFixturesEnabled()` is then re-checked as a second, independent barrier
 * (it fails closed on any unexpected NODE_ENV, and honours
 * `NEXT_PUBLIC_CHAT_FIXTURES=0`), so the rule is stated once, in one module,
 * and is not merely duplicated here.
 */
const DEV_ENV = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";

export async function resolveChatSource(): Promise<ChatSource> {
  if (!DEV_ENV || !chatFixturesEnabled()) return relayChatSource;
  if (!fixtureSource) {
    const mod = await import("./dev-fixtures/fixture-chat-source");
    fixtureSource = mod.fixtureChatSource;
  }
  return fixtureSource;
}