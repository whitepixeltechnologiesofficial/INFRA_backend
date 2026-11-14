// POST /api/session/logout — ends the Web session and clears the HttpOnly
// cookie. Idempotent: with no cookie (already logged out / expired server-side)
// it still clears and reports ok so the client can always reset to the gate.

import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookie, readCookie, webLinkApi } from "../../../lib/web-link-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = readCookie(req);
  if (token) {
    try {
      await webLinkApi(token).logoutSession();
    } catch {
      // The web session is already gone/expired server-side — logoff is still
      // reported as successful so the browser always reaches a clean state.
    }
  }
  return NextResponse.json(
    { ok: true },
    {
      headers: { "Set-Cookie": clearSessionCookie() },
    },
  );
}
