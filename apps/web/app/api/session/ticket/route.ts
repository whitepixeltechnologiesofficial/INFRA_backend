// POST /api/session/ticket — short-lived (60s) realtime socket ticket for the
// Web. Used by the lifecycle socket once a backend socket channel for the Web
// client is wired; kept server-side here so the browser never sees the session
// token (the BFF converts the HttpOnly cookie into the ticket).

import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookie, readCookie, webLinkApi } from "../../../lib/web-link-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = readCookie(req);
  if (!token) {
    return NextResponse.json({ ok: false, error: "no_session" }, { status: 401, headers: { "Set-Cookie": clearSessionCookie() } });
  }
  const res = await webLinkApi(token).sessionTicket();
  if (res.ok !== true) {
    return NextResponse.json({ ok: false, error: "ticket_failed" }, { status: 401, headers: { "Set-Cookie": clearSessionCookie() } });
  }
  return NextResponse.json({ ok: true, ticket: res.ticket });
}
