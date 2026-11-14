// GET /api/session/status — boot/health check of the HttpOnly session.
// Returns linked:true only when the BACKEND validates the cookie token.
// Distinguishes "session actually revoked" (not_authorized) from "backend
// unreachable" (unreachable) so the client never logs itself out over a
// connectivity blip.

import { NextResponse, type NextRequest } from "next/server";
import { readCookie, webLinkApi } from "../../../lib/web-link-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = readCookie(req);
  if (!token) {
    return NextResponse.json({ ok: false, linked: false, reason: "no_session" });
  }
  const res = await webLinkApi(token).sessionStatus();
  if (res.ok !== true) {
    const revoked = res.ok === false && res.error === "not_authorized";
    return NextResponse.json({
      ok: false,
      linked: false,
      reason: revoked ? "not_authorized" : "unreachable",
    });
  }
  return NextResponse.json({
    ok: true,
    linked: true,
    userId: res.userId,
    deviceId: res.deviceId,
    webSessionId: res.webSessionId,
    expiresAt: res.expiresAt,
  });
}
