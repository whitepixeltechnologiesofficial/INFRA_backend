# @wpt/web — WPT web chat

The Web client for WPT Chat: QR linking, persistent sessions, real-time
messages. This app is the **replacement** for the retired legacy demo web
server; it owns the full WEB-R1.1–R1.8 surface and is independently verified
(below). The old folder was deleted — no legacy code remains.

## Architecture

- `app/` — Next.js (React) client. `app/wpt/web-app.tsx` is the orchestrator
  (session, socket, offline outbox, chat state); `app/wpt/qr-gate.tsx` is the
  scan-to-link gate; `app/wpt/chat-app.tsx` is the chat surface; app state is
  persisted to `localStorage` keys `wpt_web_session_v1`, `wpt_web_app_state_v1`
  and `wpt_web_outbox_v1` (survives tab close / browser restart). There is no
  `sessionStorage`, no close/unload cleanup, no sync-progress UI.
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
  enters chat.
- Session survival: only a 401 from `/api/session/validate` (or a live
  `webForceLoggedOut` event after a new-phone login) ends the session. The
  phone going offline, a tab close, or a browser restart never does. Closing
  the tab simply leaves the persisted session; reopening restores it with no
  QR. (Private/incognito browsers may clear storage on close by design — that
  is expected, not a bug.)
- Logout: the ONLY logout is Settings → Logout, which hits POST
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
pnpm --filter @wpt/web run verify          # all WEB-R1 regression suites + E2E
```

During development run the server (`web:server`) and the client (`dev` /
`next start`) together; the client talks to the server via
`NEXT_PUBLIC_WPT_API_URL` (default: same origin).