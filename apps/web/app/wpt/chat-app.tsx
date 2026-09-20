"use client";

// Chat surface (WEB-R1.x). Presentational + light local state; all session,
// socket, outbox and persistence logic lives in WebApp.
//
// The ONLY logout affordance here is the explicit Settings->Logout button
// (WEB-R1.6, distinct from the automatic logout on 401/new-phone).

import React, { useMemo, useState, type JSX } from "react";
import type { WebAppStateV1, WebChatItem, WebChatMessage } from "../lib/app-state";
import type { WebSession } from "../lib/web-session";
import type { ServerUser } from "./types";
import { avatarBg, initials } from "./web-app";

export interface ChatAppProps {
  session: WebSession;
  state: WebAppStateV1;
  users: ServerUser[];
  socketOk: boolean;
  onSelectChat: (id: string) => void;
  onSendMessage: (chatId: string, text: string) => void;
  onStartChat: (userId: string) => void;
  onLogout: () => void;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function ChatRow(props: { chat: WebChatItem; active: boolean; onOpen: (id: string) => void }): JSX.Element {
  const { chat, active, onOpen } = props;
  return (
    <button type="button" className={`chat-row ${active ? "chat-row-active" : ""}`} onClick={() => onOpen(chat.id)}>
      <div className="avatar" style={{ background: chat.avatarBg }}>
        {chat.initials}
      </div>
      <div className="chat-row-body">
        <div className="chat-row-top">
          <b>{chat.name}</b>
          <span className="chat-row-time">{formatTime(chat.time)}</span>
        </div>
        <div className="chat-row-sub">
          <span className={`presence ${chat.online ? "presence-on" : ""}`}>{chat.isGroup ? "Group" : chat.online ? "Online" : "Offline"}</span>
          {chat.unread > 0 ? <span className="badge">{chat.unread > 99 ? "99+" : chat.unread}</span> : null}
        </div>
        <div className="preview">{chat.preview || "No messages yet"}</div>
      </div>
    </button>
  );
}

function MessageBubble(props: { m: WebChatMessage; mine: boolean; showName: string | null }): JSX.Element {
  const { m, mine, showName } = props;
  return (
    <div className={`msg ${mine ? "msg-mine" : ""}`}>
      {!mine && showName ? <div className="msg-name">{showName}</div> : null}
      <div className="bubble">{m.text}</div>
      <div className="msg-time">{formatTime(m.time)}</div>
    </div>
  );
}

export function ChatApp(props: ChatAppProps): JSX.Element {
  const { session, state, users, socketOk, onSelectChat, onSendMessage, onStartChat, onLogout } = props;
  const [search, setSearch] = useState("");
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const activeChat: WebChatItem | null = useMemo(
    () => state.recentChats.find((c) => c.id === state.activeChatId) ?? null,
    [state.recentChats, state.activeChatId],
  );

  const sortedChats: WebChatItem[] = useMemo(
    () => [...state.recentChats].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()),
    [state.recentChats],
  );

  const filteredChats = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedChats;
    return sortedChats.filter((c) => c.name.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q));
  }, [sortedChats, search]);

  const history: WebChatMessage[] = activeChat ? (state.chatHistory[activeChat.id] ?? []) : [];
  const me = users.find((u) => u.id === session.userId);

  function submit(): void {
    if (!activeChat) return;
    if (!draft.trim()) return;
    onSendMessage(activeChat.id, draft);
    setDraft("");
  }

  return (
    <div className="chat-shell">
      <header className="topbar">
        <div className="brand small">
          <div className="logo">S</div>
          <b>WPT Chat</b>
        </div>
        <div className="topbar-right">
          <span className={`conn ${socketOk ? "conn-on" : "conn-off"}`}>{socketOk ? "Connected" : "Reconnecting…"}</span>
          <button type="button" className="icon-btn" onClick={() => setSettingsOpen(true)} title="Settings">
            ⚙
          </button>
        </div>
      </header>

      <div className="chat-cols">
        <aside className="sidebar">
          <div className="sidebar-head">
            <input
              className="search"
              type="search"
              placeholder="Search chats…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search chats"
            />
            <button type="button" className="btn-primary" onClick={() => setNewChatOpen(true)}>
              New chat
            </button>
          </div>
          <div className="chat-list">
            {filteredChats.length === 0 ? (
              <div className="empty">No chats yet. Start one with “New chat”.</div>
            ) : (
              filteredChats.map((c) => <ChatRow key={c.id} chat={c} active={c.id === state.activeChatId} onOpen={onSelectChat} />)
            )}
          </div>
        </aside>

        <main className="thread">
          {!activeChat ? (
            <div className="thread-empty">
              <div className="logo big">S</div>
              <p>Pick a conversation to start chatting.</p>
            </div>
          ) : (
            <>
              <div className="thread-head">
                <div className="avatar" style={{ background: activeChat.avatarBg }}>
                  {activeChat.initials}
                </div>
                <div className="thread-head-body">
                  <b>{activeChat.name}</b>
                  <span className={`presence ${activeChat.online ? "presence-on" : ""}`}>
                    {activeChat.isGroup ? "Group conversation" : activeChat.online ? "Online" : "Last seen recently"}
                  </span>
                </div>
              </div>
              <div className="messages">
                {history.length === 0 ? (
                  <div className="empty">Say hello to start the conversation.</div>
                ) : (
                  history.map((m) => (
                    <MessageBubble key={m.id} m={m} mine={m.from === session.userId} showName={m.from !== session.userId && activeChat.isGroup ? users.find((u) => u.id === m.from)?.name ?? m.from : null} />
                  ))
                )}
              </div>
              <div className="composer">
                <input
                  className="composer-input"
                  type="text"
                  placeholder={`Message ${activeChat.isGroup ? activeChat.name : activeChat.name}`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                  }}
                  aria-label="Type a message"
                />
                <button type="button" className="btn-send" onClick={submit} disabled={!draft.trim()}>
                  Send
                </button>
              </div>
            </>
          )}
        </main>
      </div>

      {newChatOpen ? (
        <div className="modal-backdrop" onClick={() => setNewChatOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Start a new chat</h3>
            <div className="modal-list">
              {users
                .filter((u) => u.id !== session.userId)
                .map((u) => (
                  <button
                    type="button"
                    key={u.id}
                    className="user-row"
                    onClick={() => {
                      onStartChat(u.id);
                      setNewChatOpen(false);
                    }}
                  >
                    <span className="avatar" style={{ background: avatarBg(u.id) }}>
                      {initials(u.name)}
                    </span>
                    <span>
                      <b>{u.name}</b>
                      <small>{u.role}</small>
                    </span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Settings</h3>
            <p className="muted">
              Signed in as <b>{me?.name ?? session.userId}</b> on this device. This session lives in your browser storage
              and survives closing this tab.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
              <button type="button" className="btn-danger" onClick={onLogout}>
                Logout
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}