"use client";

// Chat surface (WEB-R1.x, WEB 2.1 Phase-5 Sealine UI). Presentational + light
// local state; all session, socket, outbox and persistence logic lives in
// WebApp. The ONLY logout affordance here is Settings → Log off (WEB-R1.6).

import React, { useEffect, useMemo, useRef, useState, type ChangeEvent, type JSX, type ReactNode } from "react";
import type { MessageStatus, WebAppStateV1, WebChatItem, WebChatMessage } from "../lib/app-state";
import type { WebSession } from "../lib/web-session";
import type { ServerGroup, ServerUser } from "./types";
import { avatarBg, initials } from "./web-app";
import { applyTheme, readThemeMode, saveThemeMode, type ThemeMode } from "../lib/theme";
import { mediaUrl, validateAttachment, type ClientMediaAttachment } from "../lib/messages";
import { buildSearchPattern, chooseMatchIndexes, splitHighlight, stepMatchIndex } from "../lib/search";
import { Seal } from "./seal";

export interface ChatAppProps {
  session: WebSession;
  state: WebAppStateV1;
  users: ServerUser[];
  groups: ServerGroup[];
  socketOk: boolean;
  // Live typing side-channel: which chats currently show the peer's typing row,
  // and the callback that announces the local user's own typing state.
  peerTyping: Record<string, boolean>;
  onTyping: (chatId: string, typing: boolean) => void;
  onSelectChat: (id: string) => void;
  onSendMessage: (chatId: string, text: string) => void;
  onSendMedia: (chatId: string, media: ClientMediaAttachment) => void;
  onStartChat: (userId: string) => void;
  onLogout: () => void;
}

type PanelKey = "new-chat" | "group-info" | "settings" | "blocked";

function cx(...parts: Array<string | boolean | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
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

function formatDateFull(iso: string | number): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "recently";
    return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "recently";
  }
}

function dayLabel(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const today = new Date();
    const startOf = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((startOf(today) - startOf(d)) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    if (d.getFullYear() === today.getFullYear()) return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
    return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

function formatRecTime(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function renderHighlight(text: string, re: RegExp | null): ReactNode {
  return splitHighlight(text, re).map((part, i) => (i % 2 === 1 ? <mark key={`${i}-${part}`} className="hl">{part}</mark> : part));
}

function browserName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Edg\//.test(ua)) return "Edge";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Browser";
}

function Avatar(props: { seed: string; name: string; size?: number }): JSX.Element {
  const { seed, name, size } = props;
  return (
    <span className="avatar" style={{ width: size ?? 42, height: size ?? 42, background: avatarBg(seed), fontSize: size ? Math.round(size * 0.34) : 15 }}>
      {initials(name)}
    </span>
  );
}

function StatusTick({ status }: { status: MessageStatus }): JSX.Element {
  if (status === "failed") {
    return (
      <span className="status" title="Failed to send">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" stroke="#E5484D" strokeWidth="1.4" />
          <path d="M8 4.5v3.6" stroke="#E5484D" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="11.1" r="1" fill="#E5484D" />
        </svg>
      </span>
    );
  }
  const double = status === "delivered" || status === "read";
  const stroke = status === "read" ? "#4C8BF5" : "#9AA0A6";
  return (
    <span className="status" title={status}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d={double ? "M1.6 8.4 4.2 11l4.2-4.4" : "M2.6 8.4 5.1 10.9 13.4 4.8"} stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        {double ? <path d="M6.8 10.9 12.8 4.6" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /> : null}
      </svg>
    </span>
  );
}

function VoiceBubble({ m }: { m: WebChatMessage }): JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const label = typeof m.durationSec === "number" ? formatRecTime(m.durationSec) : "Voice message";
  function toggle(): void {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
    } else {
      void el.play();
    }
  }
  if (!m.attachmentId) {
    return (
      <span className="b-voice" aria-label="Preparing voice message">
        <span className="b-v-play off">▶</span>
        <span className="b-v-time">{label}</span>
      </span>
    );
  }
  return (
    <span className="b-voice">
      <audio
        ref={audioRef}
        src={mediaUrl(m.attachmentId)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <button type="button" className={cx("b-v-play", playing && "on")} onClick={toggle} aria-label={playing ? "Stop" : "Play"}>
        {playing ? "❚❚" : "▶"}
      </button>
      <span className="b-v-time">{label}</span>
    </span>
  );
}

function MediaContent(props: { m: WebChatMessage }): JSX.Element {
  const { m } = props;
  if (m.kind === "image") {
    if (!m.attachmentId) {
      return (
        <span className="b-media-pending" aria-label="Preparing image">
          Preparing…
        </span>
      );
    }
    return <img className="b-img" src={mediaUrl(m.attachmentId)} alt={m.mimeType || "Image"} />;
  }
  if (m.kind === "voice") {
    return <VoiceBubble m={m} />;
  }
  return <span>{m.text}</span>;
}

function MessageBubble(props: { m: WebChatMessage; mine: boolean; name: string | null; re: RegExp | null }): JSX.Element {
  const { m, mine, name, re } = props;
  const status: MessageStatus = m.status ?? (m.tmp ? "sent" : "delivered");
  const isMedia = m.kind === "image" || m.kind === "voice";
  return (
    <div className={cx("b-msg", mine && "mine", isMedia && "media")}>
      {!mine && name ? <div className="b-name">{name}</div> : null}
      <div className="bubble">{isMedia ? <MediaContent m={m} /> : renderHighlight(m.text, re)}</div>
      <div className="b-meta">
        <span className="b-time">{formatTime(m.time)}</span>
        {mine ? <StatusTick status={status} /> : null}
      </div>
    </div>
  );
}

function ChatRow(props: { chat: WebChatItem; active: boolean; onOpen: (id: string) => void }): JSX.Element {
  const { chat, active, onOpen } = props;
  return (
    <button type="button" className={cx("ch-row", active && "ch-active")} onClick={() => onOpen(chat.id)}>
      <span className={cx("ch-avatar-wrap", chat.online && "on")}>
        <Avatar seed={chat.id} name={chat.name} size={44} />
      </span>
      <span className="ch-body">
        <span className="ch-top">
          <span className="ch-name">{chat.name}</span>
        </span>
        <span className="ch-preview">{chat.preview || "No messages yet"}</span>
      </span>
      <span className="ch-end">
        <span className="ch-time">{formatTime(chat.time)}</span>
        {chat.unread > 0 ? <span className="ch-badge">{chat.unread > 99 ? "99+" : chat.unread}</span> : null}
      </span>
    </button>
  );
}

function PanelHead(props: { title: string; onBack: () => void }): JSX.Element {
  return (
    <div className="pn-head">
      <button type="button" className="pn-back" onClick={props.onBack} aria-label="Back">
        ←
      </button>
      <div className="pn-title">{props.title}</div>
    </div>
  );
}

function NewChatPanel(props: { users: ServerUser[]; meId: string; onStart: (id: string) => void; onClose: () => void }): JSX.Element {
  const { users, meId, onStart, onClose } = props;
  const [q, setQ] = useState("");
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const pool = users.filter((u) => u.id !== meId);
    if (!needle) return pool;
    return pool.filter((u) => u.name.toLowerCase().includes(needle) || u.id.toLowerCase().includes(needle));
  }, [users, q, meId]);
  const noMatch = q.trim().length > 0 && results.length === 0;

  return (
    <>
      <PanelHead title="New chat" onBack={onClose} />
      <div className="pn-search">
        <input
          type="search"
          placeholder="Search by name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search people"
        />
      </div>
      <div className="pn-scroll scrollbar">
        <div className="sg-label">On Sealine</div>
        {results.length === 0 && !noMatch ? (
          <div className="empty" style={{ padding: "20px 4px" }}>
            No contacts synced yet. Chats you send and receive land here.
          </div>
        ) : (
          results.map((u) => (
            <button
              type="button"
              key={u.id}
              className="nc-row"
              onClick={() => {
                onStart(u.id);
                onClose();
              }}
            >
              <Avatar seed={u.id} name={u.name} size={38} />
              <span className="nc-body">
                <b>{u.name}</b>
                <small>{u.role}</small>
              </span>
              <span className={cx("role-pill", u.id === meId && "me")}>{u.role}</span>
            </button>
          ))
        )}
        {noMatch ? (
          <div className="not-on">
            <b className="mono">“{q.trim()}”</b>
            <p>This one isn&apos;t on Sealine yet. When they join, their synced number becomes a chat here automatically.</p>
          </div>
        ) : null}
        <div className="flag-note">
          This list mirrors the contacts already synced from your phone — <b>Web doesn&apos;t request its own Contacts permission.</b>
        </div>
      </div>
    </>
  );
}

function GroupInfoPanel(props: { chat: WebChatItem; group: ServerGroup | null; meId: string; onClose: () => void }): JSX.Element {
  const { chat, group, meId, onClose } = props;
  const members = group?.members ?? [];
  const owner = members.find((m) => m.role === "owner");
  const memberCount = group ? group.memberIds.length : chat.name.length > 0 ? 1 : 0;
  const sendRule = group?.settings?.membersCanMessage ? "Everyone" : "Admins";

  return (
    <>
      <PanelHead title="Group info" onBack={onClose} />
      <div className="pn-scroll scrollbar">
        <div className="gi-card">
          <div className="gi-avatar">{initials(chat.name).slice(0, 2)}</div>
          <div className="gi-name">{chat.name}</div>
          <div className="gi-sub">{group?.description ?? "Group conversation"}</div>
        </div>
        <div className="gi-note">
          Name &amp; icon are end-to-end encrypted — <b>Sealine can&apos;t read them</b>, on Web or anywhere else.
        </div>
        <div className="sg-label">Who can send messages</div>
        <div className="sg-row">
          {sendRule}
          <small>Admins can change this</small>
        </div>
        <div className="sg-label">
          Members · {memberCount}
        </div>
        {members.length === 0 ? (
          <div className="empty">Members appear here from the phone app.</div>
        ) : (
          members.map((m) => (
            <div className="gi-member" key={m.id}>
              <Avatar seed={m.id} name={m.name} size={38} />
              <span className="gi-m-body">
                <b>{m.name}</b>
                {m.id === meId ? <span className="you">You</span> : null}
              </span>
              <span className={cx("role-pill", m.role)}>{m.role === "owner" ? "OWNER" : m.role === "admin" ? "ADMIN" : "MEMBER"}</span>
            </div>
          ))
        )}
        {owner ? (
          <div className="gi-note">
            Owner protection is active — no other admin can remove or demote <b>{owner.name}</b> from this group.
          </div>
        ) : null}
      </div>
    </>
  );
}

function SettingsPanel(props: {
  meName: string;
  meRole: string;
  themeMode: ThemeMode;
  onTheme: (m: ThemeMode) => void;
  linkedAt: string | number;
  onOpenBlocked: () => void;
  onLogoff: () => void;
  onClose: () => void;
}): JSX.Element {
  const { meName, meRole, themeMode, onTheme, linkedAt, onOpenBlocked, onLogoff, onClose } = props;
  const themes: Array<{ key: ThemeMode; label: string }> = [
    { key: "light", label: "Light" },
    { key: "dark", label: "Dark" },
    { key: "system", label: "System" },
  ];
  return (
    <>
      <PanelHead title="Settings" onBack={onClose} />
      <div className="pn-scroll scrollbar">
        <div className="st-profile">
          <span className="avatar" style={{ background: "linear-gradient(150deg,#14b3a6,#0d8a80)", color: "#fff" }}>
            {initials(meName)}
          </span>
          <span>
            <b>{meName}</b>
            <small>{meRole}</small>
          </span>
        </div>

        <div className="sg-label">Phone number</div>
        <div className="sg-row">
          Synced from your phone app
          <small>This can&apos;t be changed from Web — close this tab and use the phone app to update it.</small>
        </div>

        <div className="sg-label">Theme</div>
        <div className="seg-row">
          {themes.map((t) => (
            <button key={t.key} type="button" className={cx("seg", themeMode === t.key && "seg-on")} onClick={() => onTheme(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="sg-label">This device</div>
        <div className="sg-row">
          {browserName()} · Linked {formatDateFull(linkedAt)}
          <small>This browser is the only Web session linked to your account.</small>
        </div>

        <div className="sg-label">Privacy &amp; safety</div>
        <button type="button" className="sg-item" onClick={onOpenBlocked}>
          Blocked contacts <em>›</em>
        </button>
        <button type="button" className="sg-item">
          Notifications <em>›</em>
        </button>

        <div className="sg-label">About</div>
        <button type="button" className="sg-item">
          Help centre <em>›</em>
        </button>
        <button type="button" className="sg-item">
          Terms <em>›</em>
        </button>
        <button type="button" className="sg-item">
          Privacy <em>›</em>
        </button>

        <div className="sg-ver">Web · v2.3 · build 2.3</div>
        <button type="button" className="btn-logoff" onClick={onLogoff}>
          Log off this device
        </button>
      </div>
    </>
  );
}

function BlockedPanel(props: { onClose: () => void }): JSX.Element {
  return (
    <>
      <PanelHead title="Blocked contacts" onBack={props.onClose} />
      <div className="pn-scroll scrollbar">
        <div className="empty" style={{ padding: "20px 4px" }}>
          No blocked contacts on this device.
        </div>
        <div className="flag-note">
          Blocking is managed on your phone and mirrors instantly across your phone and Web.
        </div>
      </div>
    </>
  );
}

export function ChatApp(props: ChatAppProps): JSX.Element {
  const { session, state, users, groups, socketOk, peerTyping, onTyping, onSelectChat, onSendMessage, onSendMedia, onStartChat, onLogout } = props;
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<PanelKey | null>(null);
  const [confirmLogoff, setConfirmLogoff] = useState(false);
  const [inSearchOpen, setInSearchOpen] = useState(false);
  const [inSearchQ, setInSearchQ] = useState("");
  const [inSearchIdx, setInSearchIdx] = useState(0);
  const [sendPulse, setSendPulse] = useState(false);
  const [mobileThreadOpen, setMobileThreadOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [micBlocked, setMicBlocked] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  const wasTypingRef = useRef(false);
  const typingCooldownRef = useRef(0);

  const msgsRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachErrorTimerRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recStreamRef = useRef<MediaStream | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recStartedAtRef = useRef(0);
  const recTickRef = useRef<number | null>(null);

  function showAttachError(msg: string): void {
    setAttachError(msg);
    if (attachErrorTimerRef.current !== null) window.clearTimeout(attachErrorTimerRef.current);
    attachErrorTimerRef.current = window.setTimeout(() => setAttachError(null), 5000);
  }

  function onAttachFile(e: ChangeEvent<HTMLInputElement>): void {
    const input = e.currentTarget;
    const file = input.files && input.files.length > 0 ? input.files[0] : null;
    input.value = "";
    if (!file || !activeChat) return;
    const v = validateAttachment({ kind: "image", sizeBytes: file.size, mimeType: file.type || "image/png" });
    if (!v.ok) {
      showAttachError(v.error);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        showAttachError("That image couldn't be read. Try another file.");
        return;
      }
      onSendMedia(activeChat.id, { kind: "image", dataUrl: reader.result, mimeType: file.type || "image/png", sizeBytes: file.size });
    };
    reader.onerror = () => showAttachError("That image couldn't be read. Try another file.");
    reader.readAsDataURL(file);
  }

  async function tryStartVoice(): Promise<void> {
    if (!activeChat || mediaRecorderRef.current) return;
    if (
      typeof window === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function" ||
      typeof MediaRecorder === "undefined"
    ) {
      showAttachError("Voice notes aren't supported in this browser.");
      return;
    }
    setMicBlocked(false);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMicBlocked(true);
      return;
    }
    const rec = new MediaRecorder(stream);
    mediaRecorderRef.current = rec;
    recStreamRef.current = stream;
    recChunksRef.current = [];
    rec.addEventListener("dataavailable", (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) recChunksRef.current.push(ev.data);
    });
    recStartedAtRef.current = Date.now();
    setRecording(true);
    setRecSec(0);
    if (recTickRef.current !== null) window.clearInterval(recTickRef.current);
    recTickRef.current = window.setInterval(() => {
      setRecSec((Date.now() - recStartedAtRef.current) / 1000);
    }, 250);
    try {
      rec.start();
    } catch {
      stopVoice(true);
      showAttachError("Recording couldn't start.");
    }
  }

  function stopVoice(discard: boolean): void {
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    mediaRecorderRef.current = null;
    if (recTickRef.current !== null) {
      window.clearInterval(recTickRef.current);
      recTickRef.current = null;
    }
    const startedAt = recStartedAtRef.current;
    recStartedAtRef.current = 0;
    setRecording(false);
    const stream = recStreamRef.current;
    recStreamRef.current = null;
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* closing */
        }
      }
    }
    if (discard || !activeChat) {
      recChunksRef.current = [];
      return;
    }
    rec.addEventListener("stop", () => {
      const durationSec = (Date.now() - startedAt) / 1000;
      const chunks = recChunksRef.current;
      recChunksRef.current = [];
      const mimeType = rec.mimeType && rec.mimeType.trim() ? rec.mimeType : "audio/webm";
      const blob = new Blob(chunks, { type: mimeType });
      const v = validateAttachment({ kind: "voice", sizeBytes: blob.size, mimeType, durationSec });
      if (!v.ok) {
        showAttachError(v.error);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          showAttachError("That recording couldn't be read.");
          return;
        }
        onSendMedia(activeChat.id, { kind: "voice", dataUrl: reader.result, mimeType, sizeBytes: blob.size, durationSec });
      };
      reader.onerror = () => showAttachError("That recording couldn't be read.");
      reader.readAsDataURL(blob);
    });
  }

  useEffect(() => {
    applyTheme(themeMode);
    saveThemeMode(themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (themeMode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = (): void => applyTheme("system");
    mq.addEventListener("change", onSystemChange);
    return () => mq.removeEventListener("change", onSystemChange);
  }, [themeMode]);

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const me = usersById.get(session.userId);

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

  const searchRe = useMemo(() => buildSearchPattern(inSearchQ), [inSearchQ]);

  const matchIndexes = useMemo(() => chooseMatchIndexes(history, searchRe), [history, searchRe]);

  useEffect(() => {
    if (!searchRe) return;
    const marks = msgsRef.current?.querySelectorAll("mark.hl");
    const el = marks && marks.length > 0 ? marks[Math.min(inSearchIdx, marks.length - 1)] : null;
    el?.scrollIntoView({ block: "center" });
  }, [searchRe, inSearchIdx, history]);

  const group: ServerGroup | null = useMemo(() => {
    if (!activeChat?.isGroup) return null;
    const key = activeChat.serverId ?? activeChat.id;
    return groups.find((g) => g.id === key) ?? null;
  }, [groups, activeChat]);

  const rows: JSX.Element[] = [];
  let prevDay = "";
  history.forEach((m) => {
    const day = dayLabel(m.time);
    if (day && day !== prevDay) {
      prevDay = day;
      rows.push(
        <div className="day-divider" key={`d-${m.id}`}>
          <span>{day}</span>
        </div>,
      );
    }
    rows.push(
      <MessageBubble
        key={m.id}
        m={m}
        mine={m.from === session.userId}
        name={m.from !== session.userId && activeChat?.isGroup ? (usersById.get(m.from)?.name ?? m.from) : null}
        re={searchRe}
      />,
    );
  });

  const matchCount = matchIndexes.length;

  function openChat(id: string): void {
    if (wasTypingRef.current && activeChat) {
      wasTypingRef.current = false;
      onTyping(activeChat.id, false);
    }
    onSelectChat(id);
    setMobileThreadOpen(true);
    setInSearchOpen(false);
    setInSearchQ("");
    setInSearchIdx(0);
  }

  function onDraftChange(value: string): void {
    setDraft(value);
    const chatId = activeChat?.id;
    if (!chatId) return;
    const now = Date.now();
    if (value.trim()) {
      if (!wasTypingRef.current || now >= typingCooldownRef.current) {
        wasTypingRef.current = true;
        typingCooldownRef.current = now + 2000;
        onTyping(chatId, true);
      }
    } else if (wasTypingRef.current) {
      wasTypingRef.current = false;
      onTyping(chatId, false);
    }
  }

  function sendTap(): void {
    if (!activeChat || !draft.trim()) return;
    onSendMessage(activeChat.id, draft);
    setDraft("");
    if (wasTypingRef.current) {
      wasTypingRef.current = false;
      onTyping(activeChat.id, false);
    }
    setSendPulse(true);
    window.setTimeout(() => setSendPulse(false), 320);
  }

  function stepSearch(dir: 1 | -1): void {
    setInSearchIdx((cur) => stepMatchIndex(cur, matchIndexes.length, dir));
  }

  return (
    <div className="chat-shell">
      <aside className="sidebar">
        <div className="sb-brand">
          <Seal />
          <div className="sb-brand-main">
            <div className="wordmark">Sealine</div>
            <div className="sb-tagline">web · linked device</div>
          </div>
        </div>

        <div className="sb-actions">
          <button type="button" className="sb-action" onClick={() => setPanel("new-chat")}>
            ✎ New chat
          </button>
          <button type="button" className="sb-action" onClick={() => setPanel("settings")} aria-label="Settings">
            ⚙ Settings
          </button>
        </div>

        <div className="sb-search-wrap">
          <input
            className="sb-search"
            type="search"
            placeholder="Search chats, people…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search chats"
          />
        </div>

        <div className="sb-list scrollbar">
          {sortedChats.length === 0 ? (
            <div className="sb-empty">
              <Seal />
              <b>No chats yet</b>
              <p className="sb-empty-copy">Start a conversation with someone on Sealine. Chats you send and receive land here.</p>
            </div>
          ) : filteredChats.length === 0 ? (
            <div className="empty">No chats match your search.</div>
          ) : (
            filteredChats.map((c) => <ChatRow key={c.id} chat={c} active={c.id === state.activeChatId} onOpen={openChat} />)
          )}
        </div>

        <button type="button" className="fab" onClick={() => setPanel("new-chat")} aria-label="Start a new chat">
          +
        </button>
      </aside>

      <main className={cx("thread", mobileThreadOpen && "thread-active")}>
        {!activeChat ? (
          <div className="th-empty">
            <Seal />
            <b>Pick a conversation</b>
            <p className="th-empty-copy">
              or start a new one — messages here are end-to-end encrypted, so <b>Sealine can&apos;t read them</b>, on Web or
              anywhere else.
            </p>
          </div>
        ) : (
          <>
            <div className="th-head">
              <button type="button" className="pn-back th-back" onClick={() => setMobileThreadOpen(false)} aria-label="Back to chats">
                ←
              </button>
              <span className={cx("ch-avatar-wrap", activeChat.online && "on")}>
                <Avatar seed={activeChat.id} name={activeChat.name} size={42} />
              </span>
              <div className="th-main">
                <div className="th-name">{activeChat.name}</div>
                <div className="th-sub">
                  <span className={cx("dot", !activeChat.online && "off")} />
                  {activeChat.isGroup ? "Group conversation" : activeChat.online ? "Online" : "Away"}
                </div>
              </div>
              <div className="th-actions">
                <button type="button" className="icon-btn" onClick={() => setInSearchOpen((v) => !v)} aria-label="Search in chat" title="Search in chat">
                  🔍
                </button>
                {activeChat.isGroup ? (
                  <button type="button" className="icon-btn" onClick={() => setPanel("group-info")} aria-label="Group info" title="Group info">
                    ⓘ
                  </button>
                ) : null}
              </div>
            </div>

            {!socketOk ? (
              <div className="recon" role="status">
                <span className="pulse" />
                Reconnecting…
              </div>
            ) : null}

            {inSearchOpen ? (
              <div className="in-search">
                <input
                  type="search"
                  placeholder="Search in this chat"
                  value={inSearchQ}
                  onChange={(e) => {
                    setInSearchQ(e.target.value);
                    setInSearchIdx(0);
                  }}
                  autoFocus
                  aria-label="Search in chat"
                />
                <span className="in-search-count">{matchCount > 0 ? `${Math.min(inSearchIdx, matchCount - 1) + 1} of ${matchCount}` : "0 of 0"}</span>
                <span className="nav">
                  <button type="button" className="icon-btn" onClick={() => stepSearch(-1)} aria-label="Previous match" title="Previous match">
                    ↑
                  </button>
                  <button type="button" className="icon-btn" onClick={() => stepSearch(1)} aria-label="Next match" title="Next match">
                    ↓
                  </button>
                </span>
              </div>
            ) : null}

            <div className="msgs scrollbar" ref={msgsRef}>
              {history.length === 0 ? (
                <div className="empty">
                  Say hello to start the conversation. Messages sync from your phone.
                </div>
              ) : (
                rows
              )}
            </div>

            {peerTyping[activeChat.id] ? (
              <div className="typing" role="status" aria-label={`${activeChat.name} is typing`}>
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-label">typing…</span>
              </div>
            ) : null}

            <div className="cm">
              <button type="button" className="cm-btn" title="Attach a photo" aria-label="Attach a photo" onClick={() => fileInputRef.current?.click()}>
                📎
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" className="cm-file" onChange={onAttachFile} aria-hidden="true" tabIndex={-1} />
              {recording ? (
                <div className="rec-bar" role="status">
                  <span className="rec-dot" />
                  <span className="rec-timer">{formatRecTime(recSec)}</span>
                  <span className="rec-hint">Hold to record — release to send</span>
                  <button type="button" className="rec-cancel" onClick={() => stopVoice(true)} aria-label="Discard recording">
                    ✕
                  </button>
                </div>
              ) : (
                <textarea
                  className="cm-input"
                  rows={1}
                  placeholder={`Message ${activeChat.name}`}
                  value={draft}
                  onChange={(e) => onDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendTap();
                    }
                  }}
                  aria-label="Type a message"
                />
              )}
              <button
                type="button"
                className="cm-btn"
                title="Hold to record a voice message"
                aria-label="Record a voice message"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  void tryStartVoice();
                }}
                onPointerUp={() => stopVoice(false)}
                onPointerCancel={() => stopVoice(true)}
              >
                🎤
              </button>
              <button type="button" className={cx("cm-send", sendPulse && "stamp")} onClick={sendTap} disabled={!draft.trim()} aria-label="Send">
                ➤
              </button>
            </div>
            {micBlocked ? (
              <div className="cm-err" role="alert">
                Allow microphone access in your browser to record voice notes. Messaging stays fully available.
              </div>
            ) : null}
            {attachError ? (
              <div className="cm-err" role="alert">
                {attachError}
              </div>
            ) : null}
          </>
        )}
      </main>

      {panel !== null ? (
        <div className="panel-backdrop" onClick={() => setPanel(null)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            {panel === "new-chat" ? <NewChatPanel users={users} meId={session.userId} onStart={onStartChat} onClose={() => setPanel(null)} /> : null}
            {panel === "group-info" && activeChat ? <GroupInfoPanel chat={activeChat} group={group} meId={session.userId} onClose={() => setPanel(null)} /> : null}
            {panel === "settings" ? (
              <SettingsPanel
                meName={me?.name ?? session.userId}
                meRole={me?.role ?? "member"}
                themeMode={themeMode}
                onTheme={setThemeMode}
                linkedAt={session.savedAt}
                onOpenBlocked={() => setPanel("blocked")}
                onLogoff={() => setConfirmLogoff(true)}
                onClose={() => setPanel(null)}
              />
            ) : null}
            {panel === "blocked" ? <BlockedPanel onClose={() => setPanel(null)} /> : null}
          </div>
        </div>
      ) : null}

      {confirmLogoff ? (
        <div className="modal-backdrop" onClick={() => setConfirmLogoff(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Log off this device?</h3>
            <p>
              You won&apos;t get messages on the Web until you link a new QR code from your phone. Your chats stay safe in
              your account.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={() => setConfirmLogoff(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={() => {
                  setConfirmLogoff(false);
                  setPanel(null);
                  onLogout();
                }}
              >
                Log off
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}