// Web realtime tickets — short-lived socket.io credentials.
//
// The Web client never holds its web-session token on the socket path. It
// POSTs /web-session/ticket to the backend (through the Next BFF), receives a
// 60-second single-scope JWT, and presents that ONLY in the socket handshake.
// If a ticket leaks (network dump, logs), it is worthless within a minute and
// cannot be used for any HTTP endpoint (it has aud=realtime, not the API).
//
// There are two ticket flavours, and they are NOT interchangeable:
//   - realtime ticket (aud=wpt-realtime): proves a live Web SESSION. Granted
//     only to a session token that the store says is still active.
//   - link ticket     (aud=wpt-link):     proves a live LINK REGISTRATION.
//     Granted only at registration time, and it authorises joining exactly one
//     room — `link:<sha256(token)>` — so the backend can push the login
//     hand-off to that browser. It carries the token HASH, never the token, and
//     it can never be used against an HTTP endpoint.

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { WEB_LINK_TICKET_MS, WEB_REALTIME_TICKET_MS } from "@wpt/shared";

const ISSUER = "wpt-backend";
const AUDIENCE = "wpt-realtime";
const LINK_AUDIENCE = "wpt-link";
const TICKET_TTL_S = Math.floor(WEB_REALTIME_TICKET_MS / 1000);
const LINK_TICKET_TTL_S = Math.floor(WEB_LINK_TICKET_MS / 1000);

export interface WebRealtimeTicketPayload {
  sub: string;
  deviceId: string;
  webSessionId: string;
  ticket: true;
}

export interface WebLinkTicketPayload {
  /** SHA-256(token). The raw token is never in the ticket. */
  linkId: string;
  ticket: true;
}

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set. Generate one with: openssl rand -base64 32");
  }
  return new TextEncoder().encode(secret);
}

export async function issueRealtimeTicket(input: {
  userId: string;
  deviceId: string;
  webSessionId: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ deviceId: input.deviceId, wsid: input.webSessionId, ticket: true })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(input.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + TICKET_TTL_S)
    .sign(getSecret());
}

export async function verifyRealtimeTicket(token: string): Promise<WebRealtimeTicketPayload> {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  const deviceId = typeof payload.deviceId === "string" ? payload.deviceId : undefined;
  const wsid = typeof payload.wsid === "string" ? payload.wsid : undefined;
  const ticket = payload.ticket === true;
  if (typeof payload.sub !== "string" || !deviceId || !wsid || !ticket) {
    throw new Error("Ticket payload missing required claims");
  }
  return { sub: payload.sub, deviceId, webSessionId: wsid, ticket: true };
}

/** Minted at registration; authorises joining `link:<linkId>` and nothing else. */
export async function issueLinkTicket(input: { linkId: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ lid: input.linkId, ticket: true })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(input.linkId)
    .setIssuer(ISSUER)
    .setAudience(LINK_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + LINK_TICKET_TTL_S)
    .sign(getSecret());
}

export async function verifyLinkTicket(token: string): Promise<WebLinkTicketPayload> {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: ISSUER,
    audience: LINK_AUDIENCE,
  });
  const lid = typeof payload.lid === "string" ? payload.lid : undefined;
  if (!lid || payload.ticket !== true) {
    throw new Error("Link ticket payload missing required claims");
  }
  return { linkId: lid, ticket: true };
}

export { WEB_REALTIME_TICKET_MS, TICKET_TTL_S, WEB_LINK_TICKET_MS, LINK_TICKET_TTL_S };

// Keep TS happy with the imported type (used for shape checks above).
export type { JWTPayload };