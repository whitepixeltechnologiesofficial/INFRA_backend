"use client";

// Chat surface (WEB-R1.x, WEB 2.1 Phase-5 Sealine UI). Presentational + light
// local state; all session, socket, outbox and persistence logic lives in
// WebApp. The ONLY logout affordance here is Settings → Log off (WEB-R1.6).
//
// Design notes: the conversation is the focus, so the surrounding chrome is
// quiet. The rail carries navigation, the list carries identity, and the
// transcript gets the contrast. Encryption is a small, clickable line in the
// header rather than a banner — it answers "is this private?" without
// interrupting the read.

import React, { useEffect, useMemo, useRef, useState, type ChangeEvent, type JSX, type ReactNode } from "react";
import type { MessageStatus, ReplyRef, WebAppStateV1, WebChatItem, WebChatMessage } from "../lib/app-state";
import type { WebSession } from "../lib/web-session";
import type { ServerGroup, ServerUser } from "./types";
import { initials } from "./web-app";
import { Icon } from "./icons";
import { applyTheme, readThemeMode, saveThemeMode, type ThemeMode } from "../lib/theme";
import { wptApi } from "../lib/api";
import { mediaUrl, validateAttachment, type ClientMediaAttachment } from "../lib/messages";
import { buildSearchPattern, chooseMatchIndexes, splitHighlight, stepMatchIndex } from "../lib/search";
import { MAX_TEXT_LENGTH } from "@wpt/shared";
import { EMPTY_SYNCED_CONTACTS_COPY, SYNCED_NO_MATCH_COPY, filterSyncedContacts } from "../lib/synced-contacts";
import {
  CHAT_LIST_EMPTY_COPY,
  CHAT_LIST_EMPTY_TITLE,
  CHAT_LIST_NO_MATCHES_COPY,
  CHAT_WINDOW_EMPTY_TITLE,
  decideChatListState,
  filterChats,
} from "../lib/chat-list-state";
import {
  MANUAL_NUMBER_CHECK_ACTION,
  MANUAL_NUMBER_LABEL,
  MANUAL_NUMBER_PLACEHOLDER,
  MANUAL_NUMBER_ROUTE,
  NUMBER_CHECK_UNAVAILABLE_COPY,
  NUMBER_FORMAT_ERROR_COPY,
  NUMBER_NOT_REGISTERED_COPY,
  isManualNumberCheckResponse,
  normalizeToE164,
  type ManualNumberCheckResponse,
} from "../lib/manual-number";
import { Seal } from "./seal";

export interface ChatAppProps {
  session: WebSession;
  state: WebAppStateV1;
  users: ServerUser[];
  groups: ServerGroup[];
  // WEB-2.4 — server-matched synced contacts: the ONLY list the New Chat
  // panel ever reads. Never populated from a browser Contacts API.
  synced: ServerUser[];
  socketOk: boolean;
  // Live typing side-channel: which chats currently show the peer's typing row,
  // and the callback that announces the local user's own typing state.
  peerTyping: Record<string, boolean>;
  onTyping: (chatId: string, typing: boolean) => void;
  onSelectChat: (id: string) => void;
  onSendMessage: (chatId: string, text: string, replyTo?: ReplyRef) => void;
  onSendMedia: (chatId: string, media: ClientMediaAttachment) => void;
  onRetryMessage: (chatId: string, messageId: string) => void;
  onStartChat: (userId: string) => void;
  onLogout: () => void;
}

type PanelKey = "new-chat" | "group-info" | "settings" | "devices" | "blocked";

const PANEL_TITLES: Record<PanelKey, string> = {
  "new-chat": "New chat",
  "group-info": "Group info",
  settings: "Settings",
  devices: "Linked devices",
  blocked: "Blocked contacts",
};

function cx(...parts: Array<string | boolean | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function hueIndex(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return h % 8;
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
  return "This browser";
}

function Avatar(props: { seed: string; name: string; size?: number; className?: string }): JSX.Element {
  const { seed, name, size, className } = props;
  const px = size ?? 40;
  return (
    <span className={cx("avatar", `avatar-${hueIndex(seed)}`, className)} style={{ width: px, height: px, fontSize: Math.round(px * 0.36) }}>
      {initials(name)}
    </span>
  );
}

function StatusTick({ status, onRetry }: { status: MessageStatus; onRetry?: () => void }): JSX.Element {
  if (status === "failed") {
    return (
      <button type="button" className="status" data-state="failed" onClick={onRetry} title="Failed to send — tap to retry" aria-label="Retry sending this message">
        <Icon name="alert" size={14} />
      </button>
    );
  }
  const double = status === "delivered" || status === "read";
  const label = status === "read" ? "Read" : status === "delivered" ? "Delivered" : "Sent";
  return (
    <span className="status" data-state={status} title={label}>
      <span className="sr-only">{label}</span>
      <Icon name={double ? "checkmarkDone" : "check"} size={14} />
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
        <span className="b-v-play off">
          <Icon name="play" size={15} />
        </span>
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
        <Icon name={playing ? "pause" : "play"} size={15} />
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

interface BubbleProps {
  m: WebChatMessage;
  mine: boolean;
  name: string | null;
  re: RegExp | null;
  grouped: boolean;
  selected: boolean;
  onRetry?: () => void;
  onReply: (m: WebChatMessage) => void;
  onSelect: (m: WebChatMessage) => void;
}

function MessageBubble({ m, mine, name, re, grouped, selected, onRetry, onReply, onSelect }: BubbleProps): JSX.Element {
  const isMedia = m.kind === "image" || m.kind === "voice";
  const status: MessageStatus = m.status ?? (m.tmp ? "sent" : "delivered");
  const summary = m.kind === "image" ? "Photo" : m.kind === "voice" ? "Voice message" : m.text;
  return (
    <div className={cx("b-msg", mine && "mine", grouped && "grouped", isMedia && "media", selected && "selected", status === "failed" && "failed")}>
      {!mine && name ? <div className="b-name">{name}</div> : null}
      <div className="b-msg-row">
        <div className="bubble">
          {m.replyTo ? (
            <div className="b-quote">
              <span>
                <b>{m.replyTo.name}</b> {m.replyTo.text}
              </span>
            </div>
          ) : null}
          {isMedia ? <MediaContent m={m} /> : renderHighlight(m.text, re)}
        </div>
        <div className="b-meta">
          <span className="b-time">{formatTime(m.time)}</span>
          {mine ? <StatusTick status={status} onRetry={onRetry} /> : null}
        </div>
        <div className="b-act">
          <button
            type="button"
            className="b-act-btn"
            onClick={() => onReply(m)}
            title="Reply"
            aria-label={`Reply to ${name ?? "this message"}`}
          >
            <Icon name="reply" size={14} />
          </button>
          <button
            type="button"
            className="b-act-btn"
            onClick={() => onSelect(m)}
            title="Select"
            aria-label="Select this message"
            aria-pressed={selected}
          >
            <Icon name={selected ? "checkCircle" : "check"} size={14} />
          </button>
        </div>
      </div>
      <span className="sr-only">{summary}</span>
    </div>
  );
}

function ChatRow(props: { chat: WebChatItem; active: boolean; onOpen: (id: string) => void }): JSX.Element {
  const { chat, active, onOpen } = props;
  const unread = chat.unread > 0;
  return (
    <button
      type="button"
      className={cx("ch-row", active && "ch-active", unread && "has-unread")}
      aria-current={active ? "true" : undefined}
      onClick={() => onOpen(chat.id)}
    >
      <span className={cx("ch-avatar-wrap", chat.online && "on")}>
        <Avatar seed={chat.id} name={chat.name} size={42} />
      </span>
      <span className="ch-body">
        <span className="ch-top">
          <span className="ch-name">{chat.name}</span>
          <span className="ch-time">{formatTime(chat.time)}</span>
        </span>
        <span className="ch-preview">{chat.preview || "No messages yet"}</span>
      </span>
      <span className="ch-end">
        {unread ? (
          <span className="ch-badge">
            {chat.unread > 99 ? "99+" : chat.unread}
            <span className="sr-only"> unread</span>
          </span>
        ) : null}
      </span>
    </button>
  );
}

function PanelHead(props: { title: string; onBack: () => void }): JSX.Element {
  return (
    <div className="pn-head">
      <button type="button" className="pn-back" onClick={props.onBack} aria-label="Back">
        <Icon name="chevronBack" size={20} />
      </button>
      <div className="pn-title">{props.title}</div>
    </div>
  );
}

function NewChatPanel(props: { synced: ServerUser[]; onStart: (id: string) => void; onClose: () => void }): JSX.Element {
  const { synced, onStart, onClose } = props;
  const [q, setQ] = useState("");
  // WEB-2.4 — the list is ALREADY the server match outcome; search only ever
  // narrows that list. There is no all-users view and no Contacts prompt.
  const results = useMemo(() => filterSyncedContacts(synced, q), [synced, q]);
  const noMatch = q.trim().length > 0 && results.length === 0;
  // WEB-2.5 — manual number entry. Format is validated FIRST (format error for
  // a malformed number, never a false "not registered"); a well-formed but
  // unregistered number shows the not-registered state, and that state has NO
  // invite/share affordance — Web intentionally excludes the mobile invite.
  const [manualNumber, setManualNumber] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  function checkManualNumber(): void {
    if (manualBusy) return;
    const value = manualNumber.trim();
    if (!normalizeToE164(value)) {
      setManualError(NUMBER_FORMAT_ERROR_COPY);
      return;
    }
    setManualBusy(true);
    void (async () => {
      const r = await wptApi<ManualNumberCheckResponse>("POST", MANUAL_NUMBER_ROUTE, { number: value });
      setManualBusy(false);
      if (!r.ok || !r.body) {
        setManualError((r.body as ManualNumberCheckResponse | null)?.error === "invalid_number" ? NUMBER_FORMAT_ERROR_COPY : NUMBER_CHECK_UNAVAILABLE_COPY);
        return;
      }
      if (!isManualNumberCheckResponse(r.body)) {
        setManualError(NUMBER_CHECK_UNAVAILABLE_COPY);
        return;
      }
      if (r.body.registered && r.body.user) {
        onStart(r.body.user.id);
        onClose();
        return;
      }
      setManualError(NUMBER_NOT_REGISTERED_COPY);
    })();
  }

  return (
    <>
      <PanelHead title="New chat" onBack={onClose} />
      <div className="pn-search">
        <input
          type="search"
          placeholder="Search your synced contacts"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search synced contacts"
        />
      </div>
      <div className="pn-manual">
        <div className="sg-label">{MANUAL_NUMBER_LABEL}</div>
        <div className="mn-row">
          <input
            type="tel"
            inputMode="tel"
            placeholder={MANUAL_NUMBER_PLACEHOLDER}
            value={manualNumber}
            onChange={(e) => setManualNumber(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                checkManualNumber();
              }
            }}
            aria-label="Phone number"
          />
          <button type="button" className="mn-btn" onClick={checkManualNumber} disabled={manualBusy}>
            {MANUAL_NUMBER_CHECK_ACTION}
          </button>
        </div>
        {manualError ? (
          <div className="mn-err" role="status">
            {manualError}
          </div>
        ) : null}
      </div>
      <div className="pn-scroll scrollbar">
        <div className="sg-label">Synced contacts</div>
        {synced.length === 0 ? (
          <div className="empty" style={{ padding: "20px 4px" }}>
            {EMPTY_SYNCED_CONTACTS_COPY}
          </div>
        ) : noMatch ? (
          <div className="not-on">
            <b className="mono">&ldquo;{q.trim()}&rdquo;</b>
            <p>{SYNCED_NO_MATCH_COPY}</p>
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
              <Avatar seed={u.id} name={u.name} size={36} />
              <span className="nc-body">
                <b>{u.name}</b>
                <small>{u.role}</small>
              </span>
              <span className="role-pill">{u.role}</span>
            </button>
          ))
        )}
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
              <Avatar seed={m.id} name={m.name} size={36} />
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

function DevicesPanel(props: { meName: string; onOpenBlocked: () => void; onLogoff: () => void; onClose: () => void }): JSX.Element {
  const { meName, onOpenBlocked, onLogoff, onClose } = props;
  return (
    <>
      <PanelHead title="Linked devices" onBack={onClose} />
      <div className="pn-scroll scrollbar">
        <div className="sg-label">This account</div>
        <div className="sg-row">
          {meName}
          <small>Messages sync from your phone. This browser is a view onto them, never a separate inbox.</small>
        </div>

        <div className="sg-label">Linked to this account</div>
        <div className="dev-row is-current">
          <span className="dev-icon">
            <Icon name="desktop" size={18} />
          </span>
          <span className="dev-body">
            <b>{browserName()} — this device</b>
            <small>Active now · linked from your phone</small>
          </span>
          <span className="chip chip-accent dev-tag">This device</span>
        </div>
        <div className="dev-row">
          <span className="dev-icon">
            <Icon name="phone" size={18} />
          </span>
          <span className="dev-body">
            <b>Sealine on your phone</b>
            <small>Your phone holds the account. It approves every new browser.</small>
          </span>
          <span className="chip dev-tag">Primary</span>
        </div>

        <div className="sg-label">What ending a session does</div>
        <div className="sg-row">
          Immediate, on every device
          <small>
            Signing in on a new phone closes this browser the moment it happens — instantly, with no advance warning.
            Nothing is deleted: your chats stay in your account and come back the moment you link again.
          </small>
        </div>

        <div className="sg-label">Privacy</div>
        <button type="button" className="sg-item" onClick={onOpenBlocked}>
          <span className="sg-item-lead">
            <Icon name="lock" size={18} />
            Blocked contacts
          </span>
          <Icon name="chevronForward" size={16} />
        </button>

        <div className="sg-ver">Web · v2.3 · build 2.3</div>
        <button type="button" className="btn-logoff" onClick={onLogoff}>
          Log off this device
        </button>
      </div>
    </>
  );
}

function SettingsPanel(props: {
  meName: string;
  meRole: string;
  themeMode: ThemeMode;
  onTheme: (m: ThemeMode) => void;
  onOpenDevices: () => void;
  onOpenBlocked: () => void;
  onLogoff: () => void;
  onClose: () => void;
}): JSX.Element {
  const { meName, meRole, themeMode, onTheme, onOpenDevices, onOpenBlocked, onLogoff, onClose } = props;
  const themes: Array<{ key: ThemeMode; label: string }> = [
    { key: "light", label: "Light" },
    { key: "dark", label: "Dark" },
    { key: "system", label: "System" },
  ];
  const isDark = themeMode === "dark" || (themeMode === "system" && true);
  return (
    <>
      <PanelHead title="Settings" onBack={onClose} />
      <div className="pn-scroll scrollbar">
        <div className="st-profile">
          <Avatar seed={meName} name={meName} size={44} />
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
            <button
              key={t.key}
              type="button"
              className={cx("seg", themeMode === t.key && "seg-on")}
              aria-pressed={themeMode === t.key}
              onClick={() => onTheme(t.key)}
            >
              <Icon name={t.key === "light" ? "sunny" : t.key === "dark" ? "moon" : "settings"} size={14} />
              <span className="sr-only"> </span>
              {t.label}
            </button>
          ))}
        </div>

        <div className="sg-label">Devices &amp; privacy</div>
        <button type="button" className="sg-item" onClick={onOpenDevices}>
          <span className="sg-item-lead">
            <Icon name="desktop" size={18} />
            Linked devices
          </span>
          <Icon name="chevronForward" size={16} />
        </button>
        <button type="button" className="sg-item" onClick={onOpenBlocked}>
          <span className="sg-item-lead">
            <Icon name="lock" size={18} />
            Blocked contacts
          </span>
          <Icon name="chevronForward" size={16} />
        </button>

        <div className="sg-label">Security</div>
        <div className="sg-row">
          <span className="sg-item-lead">
            <Icon name="shield" size={18} />
            End-to-end encrypted
          </span>
          <small>
            Message contents are encrypted on your devices with keys Sealine never receives. Linking is what gives this
            browser its own key — see Linked devices.
          </small>
        </div>

        <div className="sg-ver">
          Web · v2.3 · build 2.3
        </div>
        <button type="button" className="btn-logoff" onClick={onLogoff}>
          Log off this device
        </button>
        <div className="sr-only">{isDark ? "Dark theme active" : "Light theme active"}</div>
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
  const { session, state, users, groups, synced, socketOk, peerTyping, onTyping, onSelectChat, onSendMessage, onSendMedia, onRetryMessage, onStartChat, onLogout } = props;
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<PanelKey | null>(null);
  const [confirmLogoff, setConfirmLogoff] = useState(false);
  const [inSearchOpen, setInSearchOpen] = useState(false);
  const [inSearchQ, setInSearchQ] = useState("");
  const [inSearchIdx, setInSearchIdx] = useState(0);
  const [sendPulse, setSendPulse] = useState(false);
  // Phone-width web is a single pane: a chat that is already active (restored
  // from storage) must open the thread, or the user lands on a list while the
  // conversation they last read is off-screen.
  const [mobileThreadOpen, setMobileThreadOpen] = useState(() => Boolean(state.activeChatId));
  const threadPinnedRef = useRef(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [micBlocked, setMicBlocked] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  // Message-level interaction: a reply quote on the composer, and a selection
  // ring on one row at a time.
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [encOpen, setEncOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
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

  const me = useMemo(() => new Map(users.map((u) => [u.id, u])).get(session.userId) ?? null, [users, session.userId]);

  const activeChat: WebChatItem | null = useMemo(
    () => state.recentChats.find((c) => c.id === state.activeChatId) ?? null,
    [state.recentChats, state.activeChatId],
  );

  const sortedChats: WebChatItem[] = useMemo(
    () => [...state.recentChats].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()),
    [state.recentChats],
  );

  const filteredChats = useMemo(() => filterChats(sortedChats, search), [sortedChats, search]);
  const listState = useMemo(() => decideChatListState(sortedChats, search), [sortedChats, search]);

  const unreadTotal = useMemo(() => sortedChats.reduce((sum, c) => sum + (c.unread > 0 ? 1 : 0), 0), [sortedChats]);

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

  useEffect(() => {
    if (panel === null && !confirmLogoff) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (confirmLogoff) setConfirmLogoff(false);
      else if (panel !== null) setPanel(null);
      else if (encOpen) setEncOpen(false);
      else if (selectedId) setSelectedId(null);
      else if (replyTo) setReplyTo(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [panel, confirmLogoff, encOpen, selectedId, replyTo]);

  // The stored active chat can arrive after mount (state is restored from
  // storage). Keep the phone-width pane in step with it, but never fight an
  // explicit Back press.
  useEffect(() => {
    if (threadPinnedRef.current) return;
    setMobileThreadOpen((open) => (open ? open : Boolean(state.activeChatId)));
  }, [state.activeChatId]);

  useEffect(() => {
    if (panel === null) return;
    const el = panelRef.current;
    if (!el) return;
    const previous = document.activeElement as HTMLElement | null;
    el.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, [panel]);

  useEffect(() => {
    if (!encOpen) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".th-enc") || t?.closest(".th-enc-pop")) return;
      setEncOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [encOpen]);

  // Rows are built once per history; consecutive rows from the same author
  // within a minute tighten up so a long thread reads as a run, not a stack.
  const rows: JSX.Element[] = [];
  let prevDay = "";
  let prev: WebChatMessage | null = null;
  history.forEach((m) => {
    const day = dayLabel(m.time);
    if (day && day !== prevDay) {
      prevDay = day;
      prev = null;
      rows.push(
        <div className="day-divider" key={`d-${m.id}`}>
          <span>{day}</span>
        </div>,
      );
    }
    const prevTime = prev ? new Date(prev.time).getTime() : 0;
    const withinMinute = prev !== null && prev.from === m.from && Math.abs(new Date(m.time).getTime() - prevTime) < 60000;
    rows.push(
      <MessageBubble
        key={m.id}
        m={m}
        mine={m.from === session.userId}
        name={m.from !== session.userId && activeChat?.isGroup ? (me ? (users.find((u) => u.id === m.from)?.name ?? m.from) : m.from) : null}
        re={searchRe}
        grouped={Boolean(withinMinute)}
        selected={selectedId === m.id}
        onRetry={m.from === session.userId && activeChat ? () => onRetryMessage(activeChat.id, m.id) : undefined}
        onReply={(target) => {
          setSelectedId(null);
          setReplyTo({
            id: target.id,
            name: target.from === session.userId ? "You" : (users.find((u) => u.id === target.from)?.name ?? "Them"),
            text: target.kind === "image" ? "Photo" : target.kind === "voice" ? "Voice message" : target.text,
          });
          inputRef.current?.focus();
        }}
        onSelect={(target) => {
          setReplyTo(null);
          setSelectedId((cur) => (cur === target.id ? null : target.id));
        }}
      />,
    );
    prev = m;
  });

  const matchCount = matchIndexes.length;
  const selectedMessage = selectedId ? (history.find((m) => m.id === selectedId) ?? null) : null;
  const draftLen = draft.trim().length;
  const showCount = draftLen > MAX_TEXT_LENGTH * 0.6;
  const overCap = draftLen > MAX_TEXT_LENGTH;

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

  function openChat(id: string): void {
    if (wasTypingRef.current && activeChat) {
      wasTypingRef.current = false;
      onTyping(activeChat.id, false);
    }
    onSelectChat(id);
    threadPinnedRef.current = true;
    setMobileThreadOpen(true);
    setInSearchOpen(false);
    setInSearchQ("");
    setInSearchIdx(0);
    setReplyTo(null);
    setSelectedId(null);
  }

  function onDraftChange(value: string): void {
    setDraft(value);
    if (value.trim().length > MAX_TEXT_LENGTH) {
      setComposeError(`That message is too long — Sealine accepts up to ${MAX_TEXT_LENGTH.toLocaleString("en-US")} characters.`);
      return;
    }
    setComposeError(null);
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
    if (draft.trim().length > MAX_TEXT_LENGTH) {
      setComposeError(`That message is too long — Sealine accepts up to ${MAX_TEXT_LENGTH.toLocaleString("en-US")} characters.`);
      return;
    }
    setComposeError(null);
    onSendMessage(activeChat.id, draft, replyTo ?? undefined);
    setDraft("");
    setReplyTo(null);
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
      <nav className="rail" aria-label="Main">
        <div className="rail-mark">
          <Seal />
        </div>
        <button type="button" className="rail-link is-on" title="Chats" aria-label="Chats" aria-current="page">
          <Icon name="chatbubbles" size={20} />
        </button>
        <button type="button" className="rail-link" title="Linked devices" aria-label="Linked devices" onClick={() => setPanel("devices")}>
          <Icon name="desktop" size={20} />
        </button>
        <button type="button" className="rail-link" title="Settings" aria-label="Settings" onClick={() => setPanel("settings")}>
          <Icon name="settings" size={20} />
        </button>
        <div className="rail-spacer" />
        <button
          type="button"
          className="rail-btn"
          title={themeMode === "light" ? "Switch to dark" : "Switch to light"}
          aria-label={themeMode === "light" ? "Switch to dark theme" : "Switch to light theme"}
          onClick={() => setThemeMode(themeMode === "light" ? "dark" : "light")}
        >
          <Icon name={themeMode === "light" ? "moon" : "sunny"} size={19} />
        </button>
        <button type="button" className="rail-account" title="Account" aria-label="Account and settings" onClick={() => setPanel("settings")}>
          {initials(me?.name ?? session.accountName ?? "You")}
        </button>
      </nav>

      <aside className="sidebar" aria-label="Chats">
        <div className="sb-brand">
          <Seal />
          <div>
            <div className="wordmark">Sealine</div>
            <div className="wordmark-sub">web · linked device</div>
          </div>
        </div>
        <div className="sb-head">
          <div className="sb-head-text">
            <div className="sb-list-title">Chats</div>
            <div className="wordmark-sub">
              {sortedChats.length === 0
                ? "Nothing here yet"
                : `${sortedChats.length} conversation${sortedChats.length === 1 ? "" : "s"}${unreadTotal > 0 ? ` · ${unreadTotal} new` : ""}`}
            </div>
          </div>
          <div className="sb-actions">
            <button type="button" className="sb-action" onClick={() => setPanel("new-chat")} aria-label="New chat" title="New chat" aria-expanded={panel === "new-chat"}>
              <Icon name="compose" size={18} />
            </button>
            <button type="button" className="sb-action" onClick={() => setPanel("settings")} aria-label="Settings" title="Settings" aria-expanded={panel === "settings"}>
              <Icon name="settings" size={18} />
            </button>
          </div>
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
          <Icon name="search" size={16} className="sb-search-icon" />
        </div>

        <div className="sb-list scrollbar">
          {listState === "empty" ? (
            <div className="sb-empty">
              <Seal />
              <b>{CHAT_LIST_EMPTY_TITLE}</b>
              <p className="sb-empty-copy">{CHAT_LIST_EMPTY_COPY}</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPanel("new-chat")}>
                <Icon name="personAdd" size={16} />
                New chat
              </button>
            </div>
          ) : listState === "no-matches" ? (
            <div className="empty">{CHAT_LIST_NO_MATCHES_COPY}</div>
          ) : (
            filteredChats.map((c) => <ChatRow key={c.id} chat={c} active={c.id === state.activeChatId} onOpen={openChat} />)
          )}
        </div>

        <button type="button" className="fab" onClick={() => setPanel("new-chat")} aria-label="Start a new chat" title="New chat">
          <Icon name="compose" size={19} />
        </button>
      </aside>

      <main className={cx("thread", mobileThreadOpen && "thread-active")}>
        {!activeChat ? (
          <div className="th-empty">
            <Seal />
            <b>{CHAT_WINDOW_EMPTY_TITLE}</b>
            <p className="th-empty-copy">
              or start a new one — messages here are end-to-end encrypted, so <b>Sealine can&apos;t read them</b>, on Web or
              anywhere else.
            </p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPanel("new-chat")}>
              <Icon name="compose" size={16} />
              New chat
            </button>
          </div>
        ) : (
          <>
            <header className="th-head">
              <button
                type="button"
                className="pn-back th-back"
                onClick={() => {
                  threadPinnedRef.current = false;
                  setMobileThreadOpen(false);
                }}
                aria-label="Back to chats"
              >
                <Icon name="chevronBack" size={20} />
              </button>
              <span className={cx("ch-avatar-wrap", activeChat.online && "on")}>
                <Avatar seed={activeChat.id} name={activeChat.name} size={38} />
              </span>
              <div className="th-main">
                <h2 className="th-name">{activeChat.name}</h2>
                <div className="th-sub">
                  <span className={cx("dot", !activeChat.online && "off")} />
                  {activeChat.isGroup ? "Group conversation" : activeChat.online ? "Online" : "Away"}
                </div>
              </div>
              <div className="th-actions">
                <button
                  type="button"
                  className="th-enc"
                  onClick={() => setEncOpen((v) => !v)}
                  aria-expanded={encOpen}
                  title="About end-to-end encryption"
                >
                  <Icon name="lock" size={14} />
                  <span>End-to-end encrypted</span>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setInSearchOpen((v) => !v)}
                  aria-label="Search in chat"
                  aria-expanded={inSearchOpen}
                  title="Search in chat"
                >
                  <Icon name="search" size={18} />
                </button>
                {activeChat.isGroup ? (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setPanel("group-info")}
                    aria-label="Group info"
                    aria-expanded={panel === "group-info"}
                    title="Group info"
                  >
                    <Icon name="info" size={18} />
                  </button>
                ) : null}
              </div>
            </header>

            {encOpen ? (
              <div className="th-enc-pop" role="note">
                <b>End-to-end encrypted</b>
                Messages are encrypted on your devices with keys that never reach Sealine&apos;s servers. This browser got
                its own key when your phone approved the link — see Linked devices to review or end it.
              </div>
            ) : null}

            {!socketOk ? (
              <div className="recon" role="status">
                <span className="pulse" />
                Reconnecting…
              </div>
            ) : null}

            {inSearchOpen ? (
              <div className="in-search" role="search">
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
                    <Icon name="chevronUp" size={17} />
                  </button>
                  <button type="button" className="icon-btn" onClick={() => stepSearch(1)} aria-label="Next match" title="Next match">
                    <Icon name="chevronDown" size={17} />
                  </button>
                </span>
              </div>
            ) : null}

            <div className="msgs scrollbar" ref={msgsRef} role="log" aria-label={`Messages with ${activeChat.name}`} aria-live="polite">
              <div className="msgs-inner">
                {history.length === 0 ? (
                  <div className="empty">
                    Say hello to start the conversation. Messages sync from your phone.
                  </div>
                ) : (
                  rows
                )}
              </div>
            </div>

            {peerTyping[activeChat.id] ? (
              <div className="typing" role="status" aria-label={`${activeChat.name} is typing`}>
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-label">typing…</span>
              </div>
            ) : null}

            {replyTo ? (
              <div className="cm-reply">
                <div className="cm-reply-body">
                  <b>Replying to {replyTo.name}</b>
                  <span>{replyTo.text}</span>
                </div>
                <button type="button" className="cm-reply-x" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
                  <Icon name="close" size={15} />
                </button>
              </div>
            ) : selectedMessage ? (
              <div className="cm-reply">
                <div className="cm-reply-body">
                  <b>Message selected</b>
                  <span>{selectedMessage.kind === "image" ? "Photo" : selectedMessage.kind === "voice" ? "Voice message" : selectedMessage.text}</span>
                </div>
                <button type="button" className="cm-reply-x" onClick={() => setSelectedId(null)} aria-label="Clear selection">
                  <Icon name="close" size={15} />
                </button>
              </div>
            ) : null}

            <div className="cm">
              <div className="cm-inner">
                <button type="button" className="cm-btn" name="attach" title="Attach a photo" aria-label="Attach a photo" onClick={() => fileInputRef.current?.click()}>
                  <Icon name="attach" size={19} />
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" className="cm-file" onChange={onAttachFile} aria-hidden="true" tabIndex={-1} />
                {recording ? (
                  <div className="rec-bar" role="status">
                    <span className="rec-dot" />
                    <span className="rec-timer">{formatRecTime(recSec)}</span>
                    <span className="rec-hint">Recording — let go to send</span>
                    <button type="button" className="rec-cancel" onClick={() => stopVoice(true)} aria-label="Discard recording">
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                ) : (
                  <textarea
                    ref={inputRef}
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
                {!recording ? (
                  <button
                    type="button"
                    className="cm-btn"
                    name="mic"
                    title="Hold to record a voice message"
                    aria-label="Record a voice message"
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                      void tryStartVoice();
                    }}
                    onPointerUp={() => stopVoice(false)}
                    onPointerCancel={() => stopVoice(true)}
                  >
                    <Icon name="mic" size={19} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className={cx("cm-send", sendPulse && "stamp")}
                  name="send"
                  onClick={sendTap}
                  disabled={!draft.trim()}
                  aria-label="Send"
                >
                  <Icon name="send" size={18} />
                </button>
              </div>
            </div>

            {micBlocked || attachError || composeError ? (
              <div className="cm-err" role="alert">
                {micBlocked
                  ? "Allow microphone access in your browser to record voice notes. Messaging stays fully available."
                  : (attachError ?? composeError)}
              </div>
            ) : null}

            <div className="cm-foot">
              <span>Enter to send · Shift + Enter for a new line</span>
              {showCount ? (
                <span className={cx("cm-count", overCap && "is-over")}>
                  {draftLen.toLocaleString("en-US")} / {MAX_TEXT_LENGTH.toLocaleString("en-US")}
                </span>
              ) : null}
            </div>
          </>
        )}
      </main>

      {panel !== null ? (
        <div className="panel-backdrop" onClick={() => setPanel(null)}>
          <div
            className="panel"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            ref={panelRef}
            aria-label={PANEL_TITLES[panel]}
            onClick={(e) => e.stopPropagation()}
          >
            {panel === "new-chat" ? <NewChatPanel synced={synced} onStart={onStartChat} onClose={() => setPanel(null)} /> : null}
            {panel === "group-info" && activeChat ? <GroupInfoPanel chat={activeChat} group={group} meId={session.userId} onClose={() => setPanel(null)} /> : null}
            {panel === "devices" ? (
              <DevicesPanel
                meName={me?.name ?? session.userId}
                onOpenBlocked={() => setPanel("blocked")}
                onLogoff={() => setConfirmLogoff(true)}
                onClose={() => setPanel(null)}
              />
            ) : null}
            {panel === "settings" ? (
              <SettingsPanel
                meName={me?.name ?? session.userId}
                meRole={me?.role ?? "member"}
                themeMode={themeMode}
                onTheme={setThemeMode}
                onOpenDevices={() => setPanel("devices")}
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
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="logoff-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="logoff-title">Log off this device?</h3>
            <p>
              You won&apos;t get messages on the Web until you link a new QR code from your phone. Your chats stay safe in
              your account.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmLogoff(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
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
