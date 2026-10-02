// DEVELOPMENT-ONLY ChatSource: the fixture provider.
//
// Loaded exclusively through the gated dynamic import in ../chat-source.ts, so
// this module is unreachable in a production build. The guard below is a second,
// independent barrier: even if something imported this file directly, it refuses
// to produce data outside a development build.
//
// It deliberately speaks the RELAY's wire shapes, not internal UI state. That is
// what lets the real chat source drop in later without touching a component.

import { chatKey, type ChatSource, type ChatSummaryRow } from "../chat-source";
import { chatFixturesEnabled } from "../chat-fixtures-gate";
import { buildFixtureDataset, FIXTURE_SELF } from "./sample-data";
import type { ServerSentMessage } from "../../wpt/types";

export const fixtureChatSource: ChatSource = {
  kind: "fixtures",
  initialTyping: buildFixtureDataset(Date.now()).typing,

  async listChats(): Promise<ChatSummaryRow[] | null> {
    if (!chatFixturesEnabled()) return null;
    const { chats } = buildFixtureDataset(Date.now());
    return chats.map((c): ChatSummaryRow => {
      const row: ChatSummaryRow = {
        type: c.isGroup ? "group" : "direct",
        id: c.id,
        name: c.name,
        preview: c.preview,
        time: c.time,
        online: c.online,
      };
      // Initial unread only. The app keeps a locally accumulated count once it has
      // seen the row, and clears it through the real open-chat logic.
      if (c.unread > 0) row.unread = c.unread;
      return row;
    });
  },

  async loadHistory(uid: string, chat): Promise<ServerSentMessage[] | null> {
    if (!chatFixturesEnabled()) return null;
    const rows = buildFixtureDataset(Date.now()).history[chatKey(chat)];
    if (!rows) return null;

    return rows.map((m): ServerSentMessage => {
      // Outgoing rows are re-attributed to whatever account is actually signed
      // in, so incoming/outgoing styling and read receipts stay correct for the
      // real session instead of depending on a fixture-specific id.
      const out: ServerSentMessage = {
        id: m.id,
        from: m.from === FIXTURE_SELF ? uid || FIXTURE_SELF : m.from,
        text: m.text,
        time: m.time,
      };
      if (m.mKind) out.mKind = m.mKind;
      if (m.mimeType) out.mimeType = m.mimeType;
      if (typeof m.sizeBytes === "number") out.sizeBytes = m.sizeBytes;
      if (typeof m.durationSec === "number") out.durationSec = m.durationSec;
      return out;
    });
  },
};