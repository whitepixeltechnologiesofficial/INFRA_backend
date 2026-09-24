# @wpt/web — Sealine Web chat

The Web client for Sealine: QR linking, persistent sessions, real-time
messages. This app is the **replacement** for the retired legacy demo web
server; it owns the full WEB-R1.1–R1.8 surface and is independently verified
(below). The old folder was deleted — no legacy code remains.

## WEB 2.1 — Phase-5 design restyle

The UI was restyled to match the Sealine Web Phase-5 design prototype while any
session/socket/outbox logic stayed untouched:

- **Theme system** — `app/lib/theme.ts` applies `body[data-theme="dark|light"]`
  from a persisted `localStorage` key `wpt_web_theme_v1` (light / dark / system;
  system follows `prefers-color-scheme`). Dark is the canonical palette, light
  overrides it (`globals.css`). Fonts: Space Grotesk / Inter / IBM Plex Mono
  (wired in `app/layout.tsx`).
- **QR gate** — Sealine wordmark, conic countdown ring around the code
  (`--pct`), "Code expired / Generating a new one…" overlay, 3 linking steps,
  "Web only works alongside the phone app" note, Terms/Privacy/Help footer. The
  force-logout notice copy is unchanged (web-e2e asserts it). A "Logged off
  this browser" pill surfaces the manual logoff flash.
- **Linking screen** — brief "Linking your device… / fresh encryption identity"
  transition in `app/wpt/linking-screen.tsx` before chat mounts.
- **Chat surface** — Space-Grotesk sidebar (brand, ✎ New chat + ⚙ Settings,
  chat search, presence dot, unread badges, mono timestamps, selected accent
  bar), reconnecting banner, date dividers, sender labels in groups,
  sent/delivered/read/failed status ticks on outbound bubbles, in-chat search
  (highlight + "N of N" + prev/next), attach/voice/send composer with a "stamp"
  send animation, and a FAB.
- **Panels** — New chat (On Sealine / "not on Sealine yet", mirrors phone
  contacts — Web requests no Contacts permission), Group info (OWNER/ADMIN roles,
  member list, "who can send messages" from `/api/groups`, owner protection
  note), Settings (read-only phone, theme light/dark/system, this device,
  Blocked contacts, About, "Log off this device"), and a blocked-contacts panel.
  Log-off is confirm-gated and stays the only logout path.
- Verification: `scripts/web-21-verify.js` (33 checks, static + dynamic) asserts
  the Phase-5 contract AND that the restyle left the invisible-reconnect +
  session-hygiene invariants intact. It is appended to `pnpm verify`.

## WEB 2.2 — Message Sending Parity (text / image / voice)

Message sending parity with the mobile app for the three supported kinds —
**text, image, voice** (no video/file on Web, matching mobile scope). Runs over
the **live relay** (`server/wpt-server.mjs`), not a mock.

- **One shared source of truth** — `packages/shared/src/messages.ts` owns the
  kind set (`text | image | voice`), the single 100 MiB cap
  (`MAX_ATTACHMENT_BYTES`, matches mobile), the 1-second voice minimum, the
  4000-char text max, mime rules, `validateAttachment`, `formatBytes` /
  `ATTACHMENT_LIMIT_LABEL` (`"100 MB"`), and `mediaPreviewText` for recent-chat
  previews. The server pins the same constants (no drift). Error copy is shared:
  `"Attachment is too large — Sealine accepts up to 100 MB."`
- **Transport** — `packages/api-client/src/messages.ts` is a self-contained
  plain-fetch relay helper (`buildRelaySendBody` / `sendRelayMessage`) with no
  socket.io or `/api/v1` coupling, so the swap to the backend BE-5.4 relay is a
  one-line base-URL change (see below).
- **Server** — `/api/messages/send` accepts optional `kind`, `dataUrl`,
  `mimeType`, `sizeBytes`, `durationSec`. Text sends keep the **exact legacy
  relay shape** `{id, from, text, time}`. Media messages carry
  `mKind`/`attachmentId`/`mimeType`/`sizeBytes` (+`durationSec` for voice);
  bytes are stored in-memory and served at `GET /api/media/:id` (Content-Type +
  Content-Length, no-store). Rejections: 413 `attachment_too_large` (over
  100 MiB), 400 `bad_kind` (explicit unknown kinds, e.g. `video`), 400
  `bad_mime`, 400 `voice_too_short` (<1s), 400 `bad_size` (declared bytes don't
  match the payload), and a body-size guard returns 413 `payload_too_large`.
  Recent-chats previews use `mediaPreviewText` ("Image" / "Voice message").
- **Client** — `app/lib/messages.ts` bridges `@wpt/shared`; `chat-app.tsx`
  gained an enabled 📎 attach button (hidden `<input type="file" accept="image/*">`)
  and a press-and-hold 🎤 voice recorder (MediaRecorder + getUserMedia, live
  timer, cancel/send; a too-short take is discarded and mic-denied copy is
  shown). Media attached while the server address is unknown (or offline)
  renders a pending bubble and goes through the offline outbox. Image/voice
  bubbles render via `/api/media/:id`. Compose-time validation uses the same
  shared rules. Media payloads (`dataUrl`) are **in-memory only**
  (`mediaPayloadRef`) and never persisted to `localStorage`.
- Verification: `scripts/web-22-verify.js` (61 checks, static + dynamic) imports
  the shared + api-client modules as real TS (Node type-stripping), asserts the
  canonical constants and client/server hygiene, then exercises the live server:
  text/image/voice send + live WebSocket delivery, `GET /api/media/:id`
  byte-exact round-trips, history + previews, and every rejection (413 / bad
  kind / short voice / bad mime / size mismatch). Appended to `pnpm verify`
  (chain: R1.3–R1.8 + E2E + WEB 2.1 + WEB 2.2 = 277 checks).
- **BE-5.4 swap path** — point `NEXT_PUBLIC_WPT_API_URL` (or the server relay
  handler) at the backend's `POST /api/v1/messages/send` relay contract and
  serve `/api/media/:id` from backend storage; the client helpers already speak
  the same body shape. **Mobile receipt retest (pending)**: confirm an image and
  a voice note sent from the Web arrive on a physical device.

## WEB 2.3 — Read Receipts + Typing Indicators + In-thread Search

Delivery parity on the live relay: the four-state message status
(sent → delivered → read, plus terminal failed), live typing indicators with
server-side auto-clear, and in-chat search across a 50+ message thread.

- **Four-state machine (shared)** — `app/lib/receipts.ts` is a pure,
  Node-verifiable status machine (`nextMessageStatus`) with exactly the mobile
  four states (`sent | delivered | read | failed`) and events
  (`echo | read | rejected`) that never downgrades and treats `failed` as
  terminal. `applyReadReceipt` elevates only the reader's outbound messages in a
  history slice; `buildReadRequest` shapes the wire body (direct `to` vs group
  `groupId`); `lastPeerMessage` is the read-through point reported when a chat
  opens.
- **REST-only side channels (additive)** — the client WebSocket stays
  receive-only; both new writes are plain POSTs:
  `POST /api/messages/read` (`{from, type:"direct", to|groupId, messageId}`)
  reads-through to the reported id and broadcasts
  `{type:"read", from, to|groupId, messageId, messageIds, at}` to the senders'
  live sockets (direct + group alike), and
  `POST /api/messages/typing` (`{from, type:"direct", to|groupId, typing}`)
  broadcasts `{type:"typing", ..., kind}` on/off. Text-send wire shape is
  untouched. Rejections: 404 `read_not_found` / 400 `bad_read` / 400
  `bad_typing`.
- **Typing TTL** — the server arms a per-pair timer
  (`TYPING_TTL_MS`, default 5000, pinned to `@wpt/shared`'s
  `packages/shared/src/realtime.ts`); a typist who goes quiet without sending is
  auto-cleared via a server `typing:false`. The client's display safety ceiling
  (`TYPING_DISPLAY_MS`, 2500) guard the row so it can never outlive a dead
  typist. Chat keys: group typing is keyed by `groupId:from`, direct by
  `to:from`, so two users typing to each other stay independent.
- **In-thread search (shared)** — `app/lib/search.ts` is a pure, erasable-TS
  search core: `escapeRegExp` + `buildSearchPattern` produce a case-insensitive
  capture-group pattern, `chooseMatchIndexes` finds every match, `splitHighlight`
  renders matched fragments, `stepMatchIndex` wraps prev/next. The chat surface
  (`chat-app.tsx`) runs it over the loaded history with highlight + prev/next
  stepping; regex metacharacters (`R&D(alpha)?`, `a.b`) are matched literally.
- **Live typing row** — the orchestrator tracks `peerTyping` per chat
  (`chat-app.tsx` renders a `typing` row with `.typing-dot`s above the composer
  when `peerTyping[activeChat.id]`), ignores a peer's typing for the local
  context, and announces the local draft as you type (2s heartbeat) with an
  instant stop on send or chat switch. No spinner/banner/toast UI.
- Verification: `scripts/web-23-verify.js` (89 checks, static + dynamic) imports
  `realtime.ts` + `receipts.ts` + `search.ts` as real TS (Node type-stripping),
  asserts the machine/search contracts, then exercises the live server (TTL
  overridden to 400ms): live read receipts direct + group, all rejections,
  explicit typing clear + TTL auto-clear, a 57-message thread searched with
  escaped metacharacters, and the terminal `failed` state. Appended to `pnpm
  verify` (chain: R1.3–R1.8 + E2E + WEB 2.1–2.3 = 366 checks).
- **BE-5.5 swap path** — point the read/typing POSTs at the backend relay when
  it ships the read-receipt + typing endpoints; the wire shape and client
  helpers are unchanged. **Mobile receipt retest (pending)**: confirm a message
  sent from the Web goes sent → delivered → read on a physical device.

## Architecture

- `app/` — Next.js (React) client. `app/wpt/web-app.tsx` is the orchestrator
  (session, socket, offline outbox, chat state); `app/wpt/qr-gate.tsx` is the
  scan-to-link gate; `app/wpt/chat-app.tsx` is the chat surface (+ panels);
  `app/wpt/linking-screen.tsx` and `app/wpt/seal.tsx` are the branding pieces;
  app state is persisted to `localStorage` keys `wpt_web_session_v1`,
  `wpt_web_app_state_v1` and `wpt_web_outbox_v1` (survives tab close / browser
  restart). There is no `sessionStorage`, no close/unload cleanup, no
  sync-progress UI. Message send/deliver/failed state rides on
  `WebChatMessage.status`. Theme lives in the persisted `wpt_web_theme_v1`.
- `server/wpt-server.mjs` — standalone server (Node built-ins `node:http` +
  `ws`). Owns QR tokens, web sessions, chat relay, and the real-time message
  protocol. No Express, no Socket.io. Run with `pnpm web:server`
  (env: `PORT`, `QR_TTL_MS`, `PUBLIC_BASE_URL`).
- `server/vendor/QRCode/` — the vendored QR encoder (public domain) used by the
  server to render the login QR as a data-URL PNG.
- `lib/wptOutbox.js` — offline-safe outbox (UMD; same contract in Node and the
  browser).
- `scripts/` — the verification harnesses. They spawn their own server instance
  each on a private port and never require the retired code.

## Behaviour (key points)

- Linking: `/api/link/new` → phone scans `/phone/link/:token` → confirm →
  `accountLinked` over the QR socket → the Web saves `wpt_web_session_v1` and
  enters chat (brief linking transition first).
- Session survival: only a 401 from `/api/session/validate` (or a live
  `webForceLoggedOut` event after a new-phone login) ends the session. The
  phone going offline, a tab close, or a browser restart never does. Closing
  the tab simply leaves the persisted session; reopening restores it with no
  QR. (Private/incognito browsers may clear storage on close by design — that
  is expected, not a bug.)
- Logout: the ONLY logout is Settings → Log off, which hits POST
  `/api/session/logout` (server revoke) and returns to a fresh QR. It is
  distinct from the automatic cutoff, which shows a clear "Your session ended —
  a new phone signed in… scan the QR below to reconnect" notice with no grace
  period.

## Commands

From the repo root or `apps/web`:

```
pnpm --filter @wpt/web run web:server      # run the web server
pnpm --filter @wpt/web run dev             # Next.js client (dev)
pnpm --filter @wpt/web run build           # Next.js production build
pnpm --filter @wpt/web run typecheck       # tsc --noEmit
pnpm --filter @wpt/web run lint            # source-lint (offline static gate)
pnpm --filter @wpt/web run verify          # all WEB-R1 regression suites + E2E + WEB 2.1–2.3
```

During development run the server (`web:server`) and the client (`dev` /
`next start`) together; the client talks to the server via
`NEXT_PUBLIC_WPT_API_URL` (default: same origin).