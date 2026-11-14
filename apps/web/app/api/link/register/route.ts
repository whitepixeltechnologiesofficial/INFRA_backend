// POST /api/link/register — the browser registers the token IT generated.
//
// This is the gate the QR depends on. The handler receives the browser's own
// token and its PUBLIC identity bundle, hands both to the backend, and returns
// only what the browser needs next: the link id, the authoritative expiry, and
// the single-scope ticket that lets this one browser receive the push. It does
// NOT render a QR (the page does, after this returns ok:true) and it never mints
// anything of its own.

import { NextResponse, type NextRequest } from "next/server";
import { isWebLinkIdentityBundle, isWebLinkToken, type WebLinkIdentityBundle } from "@wpt/shared";
import { browserRealtimeBaseUrl, failureResponse, isBackendConfigured, webLinkApi } from "../../../lib/web-link-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isBackendConfigured()) {
    return NextResponse.json(
      { ok: false, error: "backend_unavailable", message: "The linking service is not configured. Please try again shortly." },
      { status: 503 },
    );
  }
  let body: { token?: unknown; identity?: unknown };
  try {
    body = (await req.json()) as { token?: unknown; identity?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid", message: "Malformed request." }, { status: 400 });
  }
  // Shape is checked here too, so an obviously-broken client gets a 400 without
  // spending a trip on the backend's rate limit.
  if (!isWebLinkToken(body.token) || !isWebLinkIdentityBundle(body.identity)) {
    return NextResponse.json(
      { ok: false, error: "invalid", message: "The linking request is malformed. Please refresh the page." },
      { status: 400 },
    );
  }
  try {
    const res = await webLinkApi().register({
      token: body.token,
      identity: body.identity as WebLinkIdentityBundle,
    });
    if (!res.ok) {
      const failed = failureResponse(res);
      return NextResponse.json(failed.body, { status: failed.httpStatus });
    }
    return NextResponse.json({
      ok: true,
      linkId: res.linkId,
      expiresAt: res.expiresAt,
      ttlMs: res.ttlMs,
      linkTicket: res.linkTicket,
      realtimeBaseUrl: browserRealtimeBaseUrl(),
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "backend_unavailable", message: "The linking service is unavailable right now. Please try again." },
      { status: 503 },
    );
  }
}
