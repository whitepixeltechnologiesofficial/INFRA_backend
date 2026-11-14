// The Web's own opaque linking token — the one piece of the link protocol that
// MUST be provably browser-random, so it lives in a module with no imports at
// all: nothing it could accidentally reach for, and it is directly testable
// (scripts/web-link-verify.js imports this file directly).
//
// 32 bytes from `crypto.getRandomValues` → 64 lowercase hex characters. The
// BROWSER owns this token's randomness. Never Math.random, never
// Date.now/UUID/a counter, never a phone number, userId, host or timestamp: a
// token a caller could predict is a token a stranger could scan, and the
// backend only ever stores its hash.

const TOKEN_BYTES = 32;

export const WEB_LINK_TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;

export function generateWebLinkToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
