// /api/relay/[...path] — backend-session-gated chat proxy to the chat relay.
//
// The browser NEVER talks to the chat relay directly: every chat HTTP call
// (users/groups/recent-chats/messages/send/history/read/typing/contacts,
// media) funnels through here and is forwarded to the relay ONLY after the
// web-session cookie validates against apps/backend (see relay-server.ts). A
// revoked/expired session fails the gate before the relay is ever contacted.

import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookie, readCookie } from "../../../lib/web-link-server";
import { checkWebSession, relayBaseUrl } from "../../../lib/relay-server";
import { bindPathIdentity, bindPostIdentity } from "../../../lib/relay-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function relay(req: NextRequest, segments: string[]): Promise<NextResponse> {
  const token = readCookie(req);
  if (!token) {
    return NextResponse.json({ ok: false, error: "no_session" }, { status: 401, headers: { "Set-Cookie": clearSessionCookie() } });
  }
  const status = await checkWebSession(token);
  if (status.state === "revoked") {
    return NextResponse.json({ ok: false, error: "session_invalid" }, { status: 401, headers: { "Set-Cookie": clearSessionCookie() } });
  }
  if (!status.valid) {
    // Backend unreachable / transient — relay as 502, NEVER clear the cookie on a blip.
    return NextResponse.json({ ok: false, error: "backend_unreachable" }, { status: 502 });
  }

  let forwardPath = "/" + segments.map((s) => s.split(".").join("/")).join("/");
  const url = new URL(req.url);
  const qs = url.search?.replace(/^\?/, "");

  const bound = bindPathIdentity(forwardPath, status.userId ?? "");
  if (!bound.ok) {
    return NextResponse.json({ ok: false, error: bound.error }, { status: bound.status });
  }
  forwardPath = "/" + bound.segments.join("/");

  const query: string[] = [];
  if (qs) query.push(qs);
  if (bound.appendUserId && status.userId) query.push(`userId=${encodeURIComponent(status.userId)}`);
  if (query.length > 0) forwardPath += `?${query.join("&")}`;

  const init: RequestInit = { method: req.method, headers: {} };
  const contentType = req.headers.get("content-type");
  if (contentType) init.headers = { ...(init.headers as Record<string, string>), "content-type": contentType };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const raw = await req.text();
    const body = bindPostIdentity(forwardPath.split("?")[0] ?? "", raw, status.userId ?? "");
    if (!body.ok) {
      return NextResponse.json({ ok: false, error: body.error }, { status: body.status });
    }
    init.body = body.body;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${relayBaseUrl()}${forwardPath}`, init);
  } catch {
    return NextResponse.json({ ok: false, error: "relay_unreachable" }, { status: 502 });
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  const upContentType = upstream.headers.get("content-type");
  if (upContentType) headers["content-type"] = upContentType;
  return new NextResponse(body, { status: upstream.status, headers });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  return relay(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  return relay(req, (await ctx.params).path);
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  return relay(req, (await ctx.params).path);
}
export async function PUT(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  return relay(req, (await ctx.params).path);
}