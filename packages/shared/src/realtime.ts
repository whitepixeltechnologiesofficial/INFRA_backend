// Realtime side-channel parity — the canonical timing for read receipts and
// typing indicators. Single source of truth for how long a typing indicator is
// allowed to stay visible and when it must stop if the peer types without
// sending. The WPT web server's own default is pinned to the same value here
// (the verify suite asserts they can't drift), and the Web client uses the
// display ceiling as a local safety net.
//
// NOTE: this module is deliberately self-contained and uses only erasable
// TypeScript syntax so Node's native type stripping can import it directly in
// verification harnesses.

// Server-side ceiling: while a peer keeps sending typing:true, the server
// re-arms a timer and broadcasts typing:false shortly after the last one, so a
// chat can never get stuck showing a typist who went quiet without sending.
export const TYPING_TTL_MS = 5000;

// Client-side ceiling: if a typing:false broadcast is ever lost, the UI hides
// a stale typing row on its own after this long.
export const TYPING_DISPLAY_MS = 2500;

// REST write paths for the read-receipt + typing side-channels. The Web client
// only ever writes over HTTP (its WebSocket is receive-only); both routes are
// implemented by the WPT web server.
export const READ_ROUTE = "/api/messages/read";
export const TYPING_ROUTE = "/api/messages/typing";

export function typingTtlMs(): number {
  return TYPING_TTL_MS;
}

export function typingDisplayMs(): number {
  return TYPING_DISPLAY_MS;
}