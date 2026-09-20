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
import type { ServerChatSummaryItem, ServerSentMessage, ServerRecentChats, ServerUser } from "./types";

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
  const [phase, setPhase] = useState<"gate" | "chat">("gate");
  const [session, setSession] = useState<WebSession | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [socketOk, setSocketOk] = useState(false);
  const [, setTick] = useState(0);

  const stateRef = useRef<WebAppStateV1>(defaultAppState());
  const wsRef = useRef<WebSocket | null>(null);
  const outboxRef = useRef<WptOutboxApi>(createLocalOutbox());
  const usersRef = useRef<ServerUser[]>([]);
  const historyLoadedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef(false);
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
  }

  function onVisibilityChange(): void {
    if (document.hidden) return;
    flushOutbox();
    loadRecentChats();
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

  function onIncomingServerMessage(e: WptEvent): void {
    const sessionNow = sessionRef.current;
    if (!sessionNow) return;
    const kind = typeof e.kind === "string" ? e.kind : "direct";
    const msg: WebChatMessage = {
      id: String(e.id ?? `in-${Date.now()}`),
      from: String(e.from ?? "unknown"),
      text: String(e.text ?? ""),
      time: String(e.time ?? new Date().toISOString()),
    };
    const chat = kind === "group" ? chatByGroup(String(e.groupId ?? "")) : chatByPeer(msg.from);
    if (!chat) return;
    const list = stateRef.current.recentChats;
    const existing = list.find((c) => c.id === chat.id);
    if (!existing) return;
    if (msg.from === sessionNow.userId) {
      finalizeEcho(existing.id, msg.id, msg.id);
      return;
    }
    const hist = stateRef.current.chatHistory[existing.id] ?? [];
    if (!hist.some((m) => m.id === msg.id)) hist.push(msg);
    stateRef.current.chatHistory[existing.id] = hist;
    existing.preview = msg.text;
    existing.time = msg.time;
    const isOpen = stateRef.current.activeChatId === existing.id;
    if (!isOpen) existing.unread += 1;
    persist();
    bump();
  }

  function finalizeEcho(chatId: string, tmpId: string, serverMsgId: string): void {
    const hist = stateRef.current.chatHistory[chatId] ?? [];
    const tmp = hist.find((m) => m.tmp && m.id === tmpId);
    if (!tmp) return;
    tmp.tmp = false;
    tmp.id = serverMsgId;
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
      default:
        break;
    }
  }

  function handleWSOpen(): void {
    setSocketOk(true);
    flushOutbox();
    loadRecentChats();
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
        continue;
      }
      const payload: { from: string; type: "direct" | "group"; text: string; to?: string; groupId?: string } = {
        from: uid,
        type: m.to ? "direct" : "group",
        text: m.text,
        to: m.to || undefined,
        groupId: m.to ? undefined : m.chatId || undefined,
      };
      const r = await wptApi<{ ok: boolean; message: ServerSentMessage }>("POST", "/api/messages/send", payload);
      if (r.status === 0) {
        outbox.markFailed(m.id);
      } else if (r.ok && r.body?.message) {
        outbox.markSent(m.id);
        finalizeEcho(m.chatId || "", m.id, String(r.body.message.id));
      } else {
        outbox.markFailed(m.id);
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
      if (!ids.has(mid)) hist.push({ id: mid, from: sm.from, text: sm.text, time: sm.time });
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
  }

  function sendMessage(chatId: string, text: string): void {
    const s = sessionRef.current;
    if (!s) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const chat = stateRef.current.recentChats.find((x) => x.id === chatId);
    if (!chat) return;
    const tmpMsg: WebChatMessage = { id: `tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, from: s.userId, text: trimmed, time: new Date().toISOString(), tmp: true };
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
    setPhase("chat");
  }

  useEffect(() => {
    void loadServerUsers();
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
    }
    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopTimers();
      closeSocket();
    };
  }, []);

  if (phase === "chat" && session) {
    return <ChatApp session={session} state={stateRef.current} users={usersRef.current} socketOk={socketOk} onSelectChat={openChatById} onSendMessage={sendMessage} onStartChat={startChatWith} onLogout={() => void manualLogout()} />;
  }
  return <QrGate notice={notice} onLinked={handleLinked} />;
}