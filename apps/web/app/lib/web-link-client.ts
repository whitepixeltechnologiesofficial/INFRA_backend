// Browser-side Web-linking client (R1.1–R1.5).
//
// This is the whole Web half of the linking protocol, and it is deliberately the
// ONLY place in the Web app that touches the protocol. Everything the server
// needs, the browser produces here:
//
//   1. `generateWebLinkToken()` — 32 bytes from `crypto.getRandomValues`, rendered
//      as 64 lowercase hex chars. The BROWSER owns the token's randomness.
//      Never Math.random, never Date.now/UUID/counters, never a phone number,
//      userId or timestamp.
//   2. `createWebIdentityBundle()` — an ed25519 PUBLIC key from @wpt/crypto.
//      The private key is retained in page memory only; it is never in the QR,
//      in a URL, in storage, in a log or in an error, and this module has no
//      code path that returns it to a caller that could put it on the wire.
//   3. `registerWebLink()` — POSTs {token, identity} to the BFF and only then is
//      the QR rendered. Registration is the gate: a QR for an unregistered token
//      must never reach the screen.
//   4. `openLinkChannel()` — one live connection to the EXISTING realtime
//      namespace, authenticated with the single-scope link ticket, joined to
//      `link:<hash(token)>`. The backend PUSHES the login hand-off on it; the
//      page never polls "am I linked yet?".
//   5. `redeemWebLink()` — hands the pushed single-use code to the BFF, which
//      exchanges it server-to-server and sets the HttpOnly session cookie. The
//      session credential itself never reaches this module.

import { createRealtimeClient } from "@wpt/api-client";
import { generateIdentityKeyPair } from "@wpt/crypto";
import {
  WEB_LINK_EVENTS,
  isWebLinkToken,
  type WebLinkIdentityBundle,
  type WebLinkLoginPush,
} from "@wpt/shared";
import { generateWebLinkToken } from "./web-link-token";

// ── 1. token generation ──────────────────────────────────────────────────────
// The generator itself lives in ./web-link-token (import-free, so the harness
// can hammer the real function). It is re-exported here because this module is
// the protocol's front door, and there is exactly one generator in the app.
export { WEB_LINK_TOKEN_HEX_LENGTH, generateWebLinkToken } from "./web-link-token";

// ── 2. identity (public bundle only) ─────────────────────────────────────────

/**
 * The private key is held here, in page memory, for the lifetime of the
 * document. It is intentionally NOT returned by any exported function and NOT
 * written anywhere: the protocol forbids it from travelling anywhere. The
 * getter exists so the linked-session E2EE layer can reach it later without
 * anyone re-deriving or re-persisting it.
 */
let heldPrivateKey: Uint8Array | null = null;

export function createWebIdentityBundle(): WebLinkIdentityBundle {
  const pair = generateIdentityKeyPair();
  heldPrivateKey = pair.privateKey;
  return {
    version: 1,
    publicKey: toBase64Url(pair.publicKey),
    createdAt: new Date().toISOString(),
  };
}

/** The in-memory private key, for this page's own encryption. Never serialized. */
export function webIdentityPrivateKey(): Uint8Array | null {
  return heldPrivateKey;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── 3. registration (the gate before any QR exists) ──────────────────────────

export interface WebLinkRegistered {
  ok: true;
  /**
   * The token THIS page generated. It is echoed back from the local variable,
   * never from the response body: the server only ever stores its hash and is
   * never a source of the QR's contents. The page needs it to render the QR it
   * registered.
   */
  token: string;
  linkId: string;
  /** Epoch ms from the backend's ISO expiry — the countdown's authority. */
  expiresAt: number;
  ttlMs: number;
  /** Single-scope, 60s, aud-restricted ticket for the link room only. */
  linkTicket: string;
  /** Backend origin the push channel dials. */
  realtimeBaseUrl: string;
}

export type WebLinkRegisterFailure = { ok: false; error: string; message: string };

export async function registerWebLink(): Promise<WebLinkRegistered | WebLinkRegisterFailure> {
  const token = generateWebLinkToken();
  const identity = createWebIdentityBundle();
  let body: Record<string, unknown>;
  try {
    const res = await fetch("/api/link/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ token, identity }),
    });
    body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "unreachable", message: "We couldn't reach the linking service. Check your connection and try again." };
  }
  if (body.ok !== true) {
    return {
      ok: false,
      error: typeof body.error === "string" ? body.error : "register_failed",
      message:
        typeof body.message === "string"
          ? body.message
          : "We couldn't create a login code. Please try again.",
    };
  }
  const expiresAt = Date.parse(String(body.expiresAt ?? ""));
  if (!isWebLinkToken(token) || !Number.isFinite(expiresAt) || typeof body.linkTicket !== "string") {
    return { ok: false, error: "register_failed", message: "The linking service returned an unusable response." };
  }
  return {
    ok: true,
    token,
    linkId: String(body.linkId),
    expiresAt,
    ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : 60_000,
    linkTicket: body.linkTicket,
    realtimeBaseUrl: typeof body.realtimeBaseUrl === "string" ? body.realtimeBaseUrl : "",
  };
}

// ── 4. the push channel (replaces polling) ───────────────────────────────────

export interface LinkChannel {
  close(): void;
}

export interface LinkChannelHandlers {
  /** The backend pushed the login hand-off. `code` is single-use, 60s. */
  onLogin(push: WebLinkLoginPush): void;
  /** The channel can no longer complete: rejected, or never came up. */
  onChannelLost(reason: string): void;
}

/** How long a first connection gets to come up before the cycle is abandoned. */
const CHANNEL_CONNECT_GRACE_MS = 5000;

/**
 * Open the ONE existing realtime connection for this link. There is no second
 * server and no second transport: this is the same namespace the chat client
 * already uses, joined to `link:<linkId>` with a ticket that authorises nothing
 * else.
 *
 * Losing the channel is NOT the same as losing the link, and the difference
 * matters to the user standing in front of a QR they are about to scan:
 *   · the server closing the socket (`io server disconnect` — what an invalid
 *     or expired link ticket gets) is terminal: report it at once;
 *   · a reconnect in progress, or a first attempt that has not landed yet, may
 *     still recover, so it is only reported after a short grace.
 * Reporting the first blip would throw away a perfectly good QR the moment the
 * network hiccuped, and make the phone approve a code the page no longer shows.
 */
export async function openLinkChannel(
  realtimeBaseUrl: string,
  linkTicket: string,
  handlers: LinkChannelHandlers,
): Promise<LinkChannel> {
  const channel = await createRealtimeClient({ baseUrl: realtimeBaseUrl, linkTicket });
  let closed = false;
  let everConnected = false;
  let grace: ReturnType<typeof setTimeout> | null = null;
  const lose = (reason: string): void => {
    if (closed) return;
    closed = true;
    if (grace !== null) clearTimeout(grace);
    handlers.onChannelLost(reason);
  };

  channel.on("connect", () => {
    everConnected = true;
    if (grace !== null) {
      clearTimeout(grace);
      grace = null;
    }
  });
  channel.on(WEB_LINK_EVENTS.login, (push: WebLinkLoginPush) => {
    if (closed) return;
    if (!push || typeof push.code !== "string" || !isWebLinkToken(push.code)) return;
    handlers.onLogin(push);
  });
  channel.on("disconnect", (reason: string) => {
    // A server-initiated close is a decision, not a blip: the ticket was refused.
    if (reason === "io server disconnect") lose("channel rejected");
  });
  channel.on("connect_error", (err: Error) => {
    if (closed || everConnected) return;
    if (grace !== null) return;
    grace = setTimeout(() => lose(err?.message ?? "channel unavailable"), CHANNEL_CONNECT_GRACE_MS);
  });

  return {
    close(): void {
      closed = true;
      if (grace !== null) clearTimeout(grace);
      channel.removeAllListeners();
      channel.disconnect();
    },
  };
}

// ── 5. redeeming the pushed code ─────────────────────────────────────────────

export interface WebLinkRedeemed {
  ok: true;
  userId: string;
  accountName: string;
  webSessionId: string;
  deviceId: string;
}

export async function redeemWebLink(code: string): Promise<WebLinkRedeemed | WebLinkRegisterFailure> {
  let res: Response;
  try {
    res = await fetch("/api/link/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ code }),
    });
  } catch {
    return { ok: false, error: "unreachable", message: "We couldn't reach the linking service. Check your connection and try again." };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.ok !== true) {
    return {
      ok: false,
      error: typeof body.error === "string" ? body.error : "redeem_failed",
      message:
        typeof body.message === "string" ? body.message : "That login code could not be used. Please try again.",
    };
  }
  return {
    ok: true,
    userId: String(body.userId ?? ""),
    accountName: typeof body.accountName === "string" ? body.accountName : String(body.userId ?? ""),
    webSessionId: String(body.webSessionId ?? ""),
    deviceId: String(body.deviceId ?? ""),
  };
}
