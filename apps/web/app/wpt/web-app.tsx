"use client";

// Orchestrator for the WPT Web client (WEB-R1.1–R1.8).
//
// Behaviours enforced here (each maps to a verified black-box requirement):
//   - boot restores a saved session from localStorage, skipping the QR gate;
//   - the session survives tab close and browser restart (no unload cleanup);
//   - the connection refreshes chat data fully in the background on
//     (re)connect — nothing visible is ever shown for that (WEB-R1.5);
//   - only a 401 from /api/session/validate ends the session;
//   - a webForceLoggedOut push (new phone login) ends it too: clear
//     "session ended, please rescan" notice, immediate, no countdown;
//   - manual Settings->Logout is the ONLY other logout path and it hits
//     POST /api/session/logout before clearing (WEB-R1.6).

import React, { useEffect, useRef, useState, type JSX } from "react";
import { clearWebSession, loadWebSession, saveWebSession, type WebSession } from "../lib/web-session";
import {
  clearAppStateStorage,
  defaultAppState,
  restoreAppState,
  saveAppState,
  type WebAppStateV1,
  type WebChatItem,
  type WebChatMessage,
} from "../lib/app-state";
import { wptApi } from "../lib/api";
import { buildSyncedContactsPath, isSyncedContactsPayload } from "../lib/synced-contacts";
import { openWptSocket, wptEventFromMessage, type WptEvent } from "../lib/ws";
import {
  clearOutboxStorage,
  createLocalOutbox,
  OUTBOX_MAX_TRIES,
  OUTBOX_RETRY_MS,
  type WptOutboxApi,
} from "../lib/outbox-client";
import { ChatApp } from "./chat-app";
import { QrGate } from "./qr-gate";
import { LinkingScreen } from "./linking-screen";
import { applyTheme, readThemeMode } from "../lib/theme";
import { isMessageKind, mediaPreviewText, validateAttachment, type ClientMediaAttachment } from "../lib/messages";
import { READ_ROUTE, TYPING_ROUTE, TYPING_DISPLAY_MS } from "@wpt/shared";
import { applyReadReceipt, buildReadRequest, isReceiptStatus, lastPeerMessage, nextMessageStatus } from "../lib/receipts";
import type { ServerChatSummaryItem, ServerSentMessage, ServerRecentChats, ServerUser, ServerGroup } from "./types";

const VALIDATE_INTERVAL_MS = 30_000;
const RECONNECT_MS = 3_000;
const AVATAR_COLORS = ["#6a7bfc", "#e0548a", "#f5a623", "#37b0d8", "#9b5de5", "#23b883"];

export function avatarBg(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h + ch.charCodeAt(0)) % 997;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? AVATAR_COLORS[0] ?? "#6a7bfc";
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = (parts[0] ?? "").charAt(0) ?? "";
  const last = (parts[parts.length - 1] ?? "").charAt(0) ?? "";
  return (first + (parts.length > 1 ? last : "")).toUpperCase();
}

export function WebApp(): JSX.Element {
  const [phase, setPhase] = useState<"gate" | "linking" | "chat">("gate");
  const [session, setSession] = useState<WebSession | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [flashMsg, setFlashMsg] = useState<string | null>(null);
  const [socketOk, setSocketOk] = useState(false);
  // Live typing + read-receipt side-channel (WEB-2.3). peerTyping is keyed by
  // chat id and only ever reflects the peer (our own typing is never shown).
  const [peerTyping, setPeerTyping] = useState<Record<string, boolean>>({});
  const [, setTick] = useState(0);

  const stateRef = useRef<WebAppStateV1>(defaultAppState());
  const wsRef = useRef<WebSocket | null>(null);
  const outboxRef = useRef<WptOutboxApi>(createLocalOutbox());
  // Media payloads (image data URLs / voice blobs) live here in-memory only —
  // never persisted. The outbox/journal carries just metadata (mKind, size,
  // duration); a reloaded tab has no payload and marks those entries failed.
  const mediaPayloadRef = useRef<Map<string, string>>(new Map());
  const usersRef = useRef<ServerUser[]>([]);
  // WEB-2.4 — the New Chat data source: server-matched synced contacts only.
  // Nothing here ever came from a browser Contacts prompt.
  const syncedContactsRef = useRef<ServerUser[]>([]);
  const groupsRef = useRef<ServerGroup[]>([]);
  const historyLoadedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef(false);
  // Typing safety net: a local deadline + timer per chat that hides a stale
  // typing row even if the peer's typing:false broadcast never arrives.
  const typingDeadlineRef = useRef<Map<string, number>>(new Map());
  const typingSafetyRef = useRef<Map<string, number>>(new Map());
  const reconnectTimerRef = useRef<number | null>(null);
  const validateTimerRef = useRef<number | null>(null);
  const outboxTimerRef = useRef<number | null>(null);
  const sessionRef = useRef<WebSession | null>(null);

  const handlersRef = useRef<{ onOpen: () => void; onEvent: (e: WptEvent) => void; onClose: () => void }>({
    onOpen: () => undefined,
    onEvent: () => undefined,
    onClose: () => undefined,
  });

  const bump = (): void => setTick((t) => t + 1);
  const persist = (): void => saveAppState(stateRef.current);

  function showForceLogoutNotice(reason: string | null): void {
    setNotice(reason || null);
  }

  function closeSocket(): void {
    const ws = wsRef.current;
    if (!ws) return;
    wsRef.current = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  function stopTimers(): void {
    if (validateTimerRef.current !== null) {
      window.clearInterval(validateTimerRef.current);
      validateTimerRef.current = null;
    }
    if (outboxTimerRef.current !== null) {
      window.clearInterval(outboxTimerRef.current);
      outboxTimerRef.current = null;
    }
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  function resetToGate(): void {
    setSession(null);
    sessionRef.current = null;
    setSocketOk(false);
    closeSocket();
    stopTimers();
    clearOutboxStorage();
    clearAppStateStorage();
    mediaPayloadRef.current.clear();
    stateRef.current = defaultAppState();
    historyLoadedRef.current = new Set();
    setPhase("gate");
  }

  // Logout path A — session ended (401 / webForceLoggedOut from a new phone).
  // The notice is shown first so the user always sees WHY, then the session is
  // cleared. No countdown, no "ending in X seconds" copy anywhere.
  function performSessionLogout(reason: string | null): void {
    showForceLogoutNotice(reason);
    clearWebSession();
    resetToGate();
  }

  // Logout path B — explicit Settings->Logout (WEB-R1.6). Separate from
  // path A: server is asked to revoke first, then the notice is cleared and a
  // fresh QR is presented.
  async function manualLogout(): Promise<void> {
    const s = sessionRef.current;
    if (s) {
      await wptApi("POST", "/api/session/logout", { webToken: s.webToken });
    }
    showForceLogoutNotice(null);
    clearWebSession();
    resetToGate();
    setFlashMsg("Logged off this browser");
  }

  function onVisibilityChange(): void {
    if (document.hidden) return;
    flushOutbox();
    loadRecentChats();
    void loadSyncedContacts();
  }

  async function validateWebSession(token: string): Promise<void> {
    const r = await wptApi<{ ok: boolean; userId: string }>("GET", `/api/session/validate/${encodeURIComponent(token)}`);
    if (r.status === 401) {
      performSessionLogout("revoked");
    }
  }

  function scheduleReconnect(): void {
    if (!sessionRef.current) return;
    if (reconnectTimerRef.current !== null) return;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      const s = sessionRef.current;
      if (s) connectSession(s);
    }, RECONNECT_MS);
  }

  function connectSession(s: WebSession): void {
    closeSocket();
    const ws = openWptSocket({ webToken: s.webToken });
    wsRef.current = ws;
    ws.onopen = () => handlersRef.current.onOpen();
    ws.onmessage = (ev) => {
      const e = wptEventFromMessage(ev.data);
      if (e) handlersRef.current.onEvent(e);
    };
    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
        setSocketOk(false);
        scheduleReconnect();
      }
    };
  }

  async function loadServerUsers(): Promise<void> {
    const r = await wptApi<ServerUser[]>("GET", "/api/users");
    if (r.ok && Array.isArray(r.body)) usersRef.current = r.body;
  }

  async function loadSyncedContacts(): Promise<void> {
    const s = sessionRef.current;
    if (!s || !s.webToken) return;
    const r = await wptApi<{ ok: boolean; synced: ServerUser[] }>("GET", buildSyncedContactsPath(s.webToken));
    if (r.ok && r.body && isSyncedContactsPayload(r.body)) {
      syncedContactsRef.current = r.body.synced.map((c) => ({ id: c.id, name: c.name, role: c.role ?? "member" }));
      bump();
    }
  }

  async function loadServerGroups(): Promise<void> {
    const r = await wptApi<ServerGroup[]>("GET", "/api/groups");
    if (r.ok && Array.isArray(r.body)) {
      groupsRef.current = r.body;
      bump();
    }
  }

  async function loadRecentChats(): Promise<void> {
    const uid = sessionRef.current?.userId;
    if (!uid) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const r = await wptApi<ServerRecentChats>("GET", `/api/recent-chats/${encodeURIComponent(uid)}`);
      if (!r.ok || !r.body) return;
      const previous = new Map(stateRef.current.recentChats.map((c) => [c.id, c]));
      const activeId = stateRef.current.activeChatId;
      stateRef.current.recentChats = r.body.items.map((it: ServerChatSummaryItem): WebChatItem => {
          const before = previous.get(it.id);
          return {
            id: it.id,
            serverId: it.type === "group" ? it.id : null,
            name: it.name,
            initials: initials(it.name),
            avatarBg: avatarBg(it.id),
            preview: it.preview,
            time: it.time,
            unread: before?.unread ?? 0,
            online: it.online,
            isGroup: it.type === "group",
          };
        });
      loadProfilesFor(usersRef.current);
      persist();
      bump();
    } finally {
      inFlightRef.current = false;
    }
  }

  function loadProfilesFor(_users: ServerUser[]): void {
    for (const c of stateRef.current.recentChats) {
      if (c.isGroup) continue;
      const u = _users.find((x) => x.id === c.id);
      if (u && u.name !== c.name) {
        c.name = u.name;
        c.initials = initials(u.name);
      }
    }
  }

  function chatByPeer(peerId: string): WebChatItem | null {
    const matching = stateRef.current.recentChats.find((c) => !c.isGroup && (c.serverId === peerId || c.id === peerId));
    if (matching) return matching;
    const u = usersRef.current.find((x) => x.id === peerId);
    if (!u) return null;
    const item: WebChatItem = {
      id: u.id,
      serverId: null,
      name: u.name,
      initials: initials(u.name),
      avatarBg: avatarBg(u.id),
      preview: "",
      time: new Date().toISOString(),
      unread: 0,
      online: false,
      isGroup: false,
    };
    stateRef.current.recentChats.unshift(item);
    return item;
  }

  function chatByGroup(groupId: string): WebChatItem | null {
    return stateRef.current.recentChats.find((c) => c.isGroup && (c.serverId === groupId || c.id === groupId)) ?? null;
  }

  // Look up a direct chat WITHOUT creating a row — typing/read side-channel
  // events must never fabricate a chat the user hasn't actually messaged.
  function chatByPeerIfExists(peerId: string): WebChatItem | null {
    return stateRef.current.recentChats.find((c) => !c.isGroup && (c.serverId === peerId || c.id === peerId)) ?? null;
  }

  // Hide a chat's typing row (and cancel its safety timer). Keeping the timer
  // here centralizes the cheap cleanup on every typing:false or new message.
  function clearPeerTyping(chatId: string): void {
    const safety = typingSafetyRef.current.get(chatId);
    if (safety !== undefined) {
      window.clearTimeout(safety);
      typingSafetyRef.current.delete(chatId);
    }
    typingDeadlineRef.current.delete(chatId);
    setPeerTyping((prev) => {
      if (!prev[chatId]) return prev;
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
  }

  function showPeerTyping(chatId: string): void {
    const safety = typingSafetyRef.current.get(chatId);
    if (safety !== undefined) window.clearTimeout(safety);
    const deadline = Date.now() + TYPING_DISPLAY_MS;
    typingDeadlineRef.current.set(chatId, deadline);
    typingSafetyRef.current.set(chatId, window.setTimeout(() => {
      typingSafetyRef.current.delete(chatId);
      if (typingDeadlineRef.current.get(chatId) === deadline) clearPeerTyping(chatId);
    }, TYPING_DISPLAY_MS));
    setPeerTyping((prev) => (prev[chatId] ? prev : { ...prev, [chatId]: true }));
  }

  function onTypingEvent(e: WptEvent): void {
    const s = sessionRef.current;
    if (!s) return;
    const uid = String(e.from ?? "");
    if (!uid || uid === s.userId) return;
    const kind = typeof e.kind === "string" ? e.kind : "direct";
    const chat = kind === "group" && typeof e.groupId === "string" ? chatByGroup(e.groupId) : chatByPeerIfExists(uid);
    if (!chat) return;
    if (e.typing === true) showPeerTyping(chat.id);
    else clearPeerTyping(chat.id);
  }

  function onReadReceipt(e: WptEvent): void {
    const s = sessionRef.current;
    if (!s) return;
    const ids = Array.isArray(e.messageIds)
      ? e.messageIds.filter((x) => typeof x === "string" || typeof x === "number").map(String)
      : typeof e.messageId === "string" || typeof e.messageId === "number"
        ? [String(e.messageId)]
        : [];
    if (ids.length === 0) return;
    const kind = typeof e.kind === "string" ? e.kind : "direct";
    const chat = kind === "group" && typeof e.groupId === "string" ? chatByGroup(e.groupId) : chatByPeerIfExists(String(e.from ?? ""));
    if (!chat) return;
    const hist = stateRef.current.chatHistory[chat.id];
    if (!hist) return;
    if (applyReadReceipt(hist, ids, s.userId) > 0) {
      persist();
      bump();
    }
  }

  // Report to the relay that a message of the peer's is now read by me. The
  // server reads-through to that id and broadcasts who-read-what to the senders.
  async function reportRead(chat: WebChatItem, messageId: string): Promise<void> {
    const s = sessionRef.current;
    if (!s || !messageId) return;
    await wptApi("POST", READ_ROUTE, buildReadRequest({ from: s.userId, isGroup: chat.isGroup, to: chat.serverId ?? chat.id, groupId: chat.serverId ?? chat.id, messageId }));
  }

  // Announce that the local (Web) user is/stopped typing in a chat. The Web
  // client only writes over HTTP; the relay fans it out over the sockets.
  async function announceTyping(chat: WebChatItem, typing: boolean): Promise<void> {
    const s = sessionRef.current;
    if (!s) return;
    const body: Record<string, unknown> = { from: s.userId, type: chat.isGroup ? "group" : "direct", typing };
    if (chat.isGroup) body.groupId = chat.serverId ?? chat.id;
    else body.to = chat.serverId ?? chat.id;
    await wptApi("POST", TYPING_ROUTE, body);
  }

  function sendTyping(chatId: string, typing: boolean): void {
    const chat = stateRef.current.recentChats.find((x) => x.id === chatId);
    if (!chat) return;
    void announceTyping(chat, typing);
  }

  function onIncomingServerMessage(e: WptEvent): void {
    const sessionNow = sessionRef.current;
    if (!sessionNow) return;
    const kind = typeof e.kind === "string" ? e.kind : "direct";
    const msgKind = isMessageKind(e.mKind) ? e.mKind : "text";
    const msg: WebChatMessage = {
      id: String(e.id ?? `in-${Date.now()}`),
      from: String(e.from ?? "unknown"),
      text: String(e.text ?? ""),
      time: String(e.time ?? new Date().toISOString()),
      kind: msgKind,
      attachmentId: typeof e.attachmentId === "string" || typeof e.attachmentId === "number" ? String(e.attachmentId) : undefined,
      mimeType: typeof e.mimeType === "string" ? e.mimeType : undefined,
      sizeBytes: typeof e.sizeBytes === "number" ? e.sizeBytes : undefined,
      durationSec: typeof e.durationSec === "number" ? e.durationSec : undefined,
    };
    const chat = kind === "group" ? chatByGroup(String(e.groupId ?? "")) : chatByPeer(msg.from);
    if (!chat) return;
    const list = stateRef.current.recentChats;
    const existing = list.find((c) => c.id === chat.id);
    if (!existing) return;
    if (msg.from === sessionNow.userId) {
      finalizeEcho(existing.id, msg.id, msg.id, msg);
      return;
    }
    const hist = stateRef.current.chatHistory[existing.id] ?? [];
    if (!hist.some((m) => m.id === msg.id)) hist.push(msg);
    stateRef.current.chatHistory[existing.id] = hist;
    existing.preview = msgKind === "text" ? msg.text : mediaPreviewText(msgKind);
    existing.time = msg.time;
    const isOpen = stateRef.current.activeChatId === existing.id;
    if (!isOpen) existing.unread += 1;
    else if (msg.from !== sessionNow.userId) void reportRead(existing, msg.id);
    persist();
    bump();
  }

  function finalizeEcho(chatId: string, tmpId: string, serverMsgId: string, extra?: ServerSentMessage): void {
    const hist = stateRef.current.chatHistory[chatId] ?? [];
    const tmp = hist.find((m) => m.tmp && m.id === tmpId);
    if (!tmp) return;
    tmp.tmp = false;
    tmp.id = serverMsgId;
    tmp.status = nextMessageStatus(isReceiptStatus(tmp.status) ? tmp.status : null, "echo");
    if (extra) {
      if (isMessageKind(extra.mKind)) tmp.kind = extra.mKind;
      if (extra.attachmentId != null) tmp.attachmentId = String(extra.attachmentId);
      if (typeof extra.mimeType === "string") tmp.mimeType = extra.mimeType;
      if (typeof extra.sizeBytes === "number") tmp.sizeBytes = extra.sizeBytes;
      if (typeof extra.durationSec === "number") tmp.durationSec = extra.durationSec;
    }
    mediaPayloadRef.current.delete(tmpId);
    persist();
    bump();
  }

  function markLocalFailed(chatId: string, tmpId: string): void {
    mediaPayloadRef.current.delete(tmpId);
    const hist = stateRef.current.chatHistory[chatId] ?? [];
    const m = hist.find((x) => x.tmp && x.id === tmpId);
    if (!m) return;
    m.status = "failed";
    persist();
    bump();
  }

  function onPresenceChanged(e: WptEvent): void {
    const uid = String(e.userId ?? "");
    if (!uid) return;
    for (const c of stateRef.current.recentChats) {
      if (!c.isGroup && (c.serverId === uid || c.id === uid)) c.online = Boolean(e.online);
    }
    bump();
  }

  function handleServerEvent(e: WptEvent): void {
    switch (e.type) {
      case "message":
      case "mockIncomingMessage":
        onIncomingServerMessage(e);
        break;
      case "webForceLoggedOut":
        performSessionLogout(typeof e.reason === "string" && e.reason ? e.reason : null);
        break;
      case "presenceChanged":
        onPresenceChanged(e);
        break;
      case "read":
        onReadReceipt(e);
        break;
      case "typing":
        onTypingEvent(e);
        break;
      default:
        break;
    }
  }

  function handleWSOpen(): void {
    setSocketOk(true);
    flushOutbox();
    loadRecentChats();
    void loadSyncedContacts();
  }

  function handleWSClose(): void {
    scheduleReconnect();
  }

  handlersRef.current = { onOpen: handleWSOpen, onEvent: handleServerEvent, onClose: handleWSClose };

  async function flushOutbox(): Promise<void> {
    const uid = sessionRef.current?.userId;
    if (!uid) return;
    const outbox = outboxRef.current;
    const pending = outbox.pending();
    if (pending.length === 0) return;
    for (const m of pending) {
      if ((m.attempts ?? 0) >= OUTBOX_MAX_TRIES) {
        outbox.markFailed(m.id);
        markLocalFailed(m.chatId || "", m.id);
        continue;
      }
      const payload: Record<string, unknown> = {
        from: uid,
        type: m.to ? "direct" : "group",
        text: m.text,
        to: m.to || undefined,
        groupId: m.to ? undefined : m.chatId || undefined,
      };
      if (m.kind === "image" || m.kind === "voice") {
        const dataUrl = mediaPayloadRef.current.get(m.id);
        if (!dataUrl) {
          outbox.markFailed(m.id);
          markLocalFailed(m.chatId || "", m.id);
          continue;
        }
        payload.kind = m.kind;
        payload.dataUrl = dataUrl;
        payload.mimeType = m.mimeType;
        payload.sizeBytes = m.sizeBytes;
        if (m.kind === "voice" && typeof m.durationSec === "number") payload.durationSec = m.durationSec;
      }
      const r = await wptApi<{ ok: boolean; message: ServerSentMessage }>("POST", "/api/messages/send", payload);
      if (r.status === 0) {
        outbox.markFailed(m.id);
        markLocalFailed(m.chatId || "", m.id);
      } else if (r.ok && r.body?.message) {
        outbox.markSent(m.id);
        finalizeEcho(m.chatId || "", m.id, String(r.body.message.id), r.body.message);
      } else {
        outbox.markFailed(m.id);
        markLocalFailed(m.chatId || "", m.id);
      }
    }
  }

  async function serverChatHistory(chat: WebChatItem): Promise<void> {
    const uid = sessionRef.current?.userId;
    if (!uid) return;
    const historyKey = chat.isGroup ? chat.serverId || chat.id : chat.serverId || chat.id;
    if (!historyKey) return;
    if (historyLoadedRef.current.has(historyKey)) return;
    const path = chat.isGroup
      ? `/api/group-messages/${encodeURIComponent(historyKey)}`
      : `/api/messages/${encodeURIComponent(uid)}/${encodeURIComponent(historyKey)}`;
    const r = await wptApi<ServerSentMessage[]>("GET", path);
    if (!r.ok || !Array.isArray(r.body)) return;
    historyLoadedRef.current.add(historyKey);
    const hist = stateRef.current.chatHistory[chat.id] ?? [];
    const ids = new Set(hist.map((m) => m.id));
    for (const sm of r.body) {
      const mid = String(sm.id);
      if (!ids.has(mid)) {
        const smKind = isMessageKind(sm.mKind) ? sm.mKind : "text";
        hist.push({
          id: mid,
          from: sm.from,
          text: sm.text,
          time: sm.time,
          kind: smKind,
          attachmentId: sm.attachmentId != null ? String(sm.attachmentId) : undefined,
          mimeType: typeof sm.mimeType === "string" ? sm.mimeType : undefined,
          sizeBytes: typeof sm.sizeBytes === "number" ? sm.sizeBytes : undefined,
          durationSec: typeof sm.durationSec === "number" ? sm.durationSec : undefined,
        });
      }
    }
    stateRef.current.chatHistory[chat.id] = hist;
    const first = hist[0];
    if (first && chat.preview === "") {
      chat.preview = first.text;
      chat.time = first.time;
    }
    persist();
    bump();
  }

  function openChatById(chatId: string): void {
    const c = stateRef.current.recentChats.find((x) => x.id === chatId);
    if (!c) return;
    stateRef.current.activeChatId = chatId;
    c.unread = 0;
    persist();
    bump();
    void serverChatHistory(c);
    const hist = stateRef.current.chatHistory[chatId] ?? [];
    const lastPeer = lastPeerMessage(hist, sessionRef.current?.userId ?? "");
    if (lastPeer) void reportRead(c, lastPeer.id);
  }

  function sendMessage(chatId: string, text: string): void {
    const s = sessionRef.current;
    if (!s) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const chat = stateRef.current.recentChats.find((x) => x.id === chatId);
    if (!chat) return;
    const tmpMsg: WebChatMessage = { id: `tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, from: s.userId, text: trimmed, time: new Date().toISOString(), tmp: true, status: "sent" };
    const hist = stateRef.current.chatHistory[chatId] ?? [];
    hist.push(tmpMsg);
    stateRef.current.chatHistory[chatId] = hist;
    persist();
    bump();
    outboxRef.current.enqueue({
      id: tmpMsg.id,
      chatId,
      to: chat.isGroup ? null : chat.serverId || chat.id,
      from: s.userId,
      text: trimmed,
    });
    void flushOutbox();
  }

  function sendMedia(chatId: string, attach: ClientMediaAttachment): void {
    const s = sessionRef.current;
    if (!s) return;
    const chat = stateRef.current.recentChats.find((x) => x.id === chatId);
    if (!chat) return;
    const v = validateAttachment({ kind: attach.kind, sizeBytes: attach.sizeBytes, mimeType: attach.mimeType, durationSec: attach.durationSec });
    if (!v.ok) return;
    const tmpMsg: WebChatMessage = {
      id: `tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      from: s.userId,
      text: "",
      time: new Date().toISOString(),
      tmp: true,
      status: "sent",
      kind: attach.kind,
      mimeType: attach.mimeType,
      sizeBytes: attach.sizeBytes,
      durationSec: attach.durationSec,
    };
    const hist = stateRef.current.chatHistory[chatId] ?? [];
    hist.push(tmpMsg);
    stateRef.current.chatHistory[chatId] = hist;
    persist();
    bump();
    mediaPayloadRef.current.set(tmpMsg.id, attach.dataUrl);
    outboxRef.current.enqueue({
      id: tmpMsg.id,
      chatId,
      to: chat.isGroup ? null : chat.serverId || chat.id,
      from: s.userId,
      text: "",
      kind: attach.kind,
      mimeType: attach.mimeType,
      sizeBytes: attach.sizeBytes,
      durationSec: attach.durationSec,
    });
    void flushOutbox();
  }

  function startChatWith(userId: string): void {
    const s = sessionRef.current;
    if (!s || userId === s.userId) return;
    const existing = stateRef.current.recentChats.find((c) => !c.isGroup && (c.serverId === userId || c.id === userId));
    const chatId = existing ? existing.id : userId;
    if (!existing) {
      const u = usersRef.current.find((x) => x.id === userId);
      const item: WebChatItem = {
        id: userId,
        serverId: null,
        name: u?.name || userId,
        initials: initials(u?.name || userId),
        avatarBg: avatarBg(userId),
        preview: "",
        time: new Date().toISOString(),
        unread: 0,
        online: false,
        isGroup: false,
      };
      stateRef.current.recentChats.unshift(item);
      persist();
      bump();
    }
    openChatById(chatId);
  }

  function handleLinked(webToken: string, userId: string): void {
    showForceLogoutNotice(null);
    const newSession: WebSession = { webToken, userId, savedAt: Date.now() };
    saveWebSession(webToken, userId);
    sessionRef.current = newSession;
    setSession(newSession);
    stateRef.current = defaultAppState();
    historyLoadedRef.current = new Set();
    connectSession(newSession);
    if (validateTimerRef.current === null) {
      validateTimerRef.current = window.setInterval(() => {
        const current = sessionRef.current;
        if (current) void validateWebSession(current.webToken);
      }, VALIDATE_INTERVAL_MS);
    }
    if (outboxTimerRef.current === null) {
      outboxTimerRef.current = window.setInterval(() => {
        void flushOutbox();
      }, OUTBOX_RETRY_MS);
    }
    void loadRecentChats();
    void loadSyncedContacts();
    setPhase("linking");
    window.setTimeout(() => setPhase("chat"), 900);
  }

  useEffect(() => {
    applyTheme(readThemeMode());
    void loadServerUsers();
    void loadServerGroups();
    document.addEventListener("visibilitychange", onVisibilityChange);
    const saved = loadWebSession();
    let mounted = true;
    if (saved && saved.webToken) {
      // Boot restore: a live session short-circuits the QR gate entirely.
      stateRef.current = restoreAppState();
      sessionRef.current = saved;
      setSession(saved);
      setPhase("chat");
      connectSession(saved);
      if (validateTimerRef.current === null) {
        validateTimerRef.current = window.setInterval(() => {
          const current = sessionRef.current;
          if (current) void validateWebSession(current.webToken);
        }, VALIDATE_INTERVAL_MS);
      }
      if (outboxTimerRef.current === null) {
        outboxTimerRef.current = window.setInterval(() => {
          void flushOutbox();
        }, OUTBOX_RETRY_MS);
      }
      void loadRecentChats();
      void loadSyncedContacts();
    }
    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopTimers();
      closeSocket();
    };
  }, []);

  if (phase === "chat" && session) {
    return (
      <ChatApp
        session={session}
        state={stateRef.current}
        users={usersRef.current}
        groups={groupsRef.current}
        synced={syncedContactsRef.current}
        socketOk={socketOk}
        peerTyping={peerTyping}
        onTyping={sendTyping}
        onSelectChat={openChatById}
        onSendMessage={sendMessage}
        onSendMedia={sendMedia}
        onStartChat={startChatWith}
        onLogout={() => void manualLogout()}
      />
    );
  }
  if (phase === "linking") {
    return <LinkingScreen />;
  }
  return <QrGate notice={notice} flash={flashMsg} onLinked={handleLinked} onFlashClear={() => setFlashMsg(null)} />;
}