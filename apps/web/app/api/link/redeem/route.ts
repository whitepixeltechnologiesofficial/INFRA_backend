// POST /api/link/redeem — spend the server-PUSHED code for a Web session.
//
// This handler is the trust boundary that keeps the long-lived session
// credential out of the browser. The page holds a single-use, 60-second code and
// nothing else; this handler exchanges it with the backend SERVER-TO-SERVER,
// writes the returned session token straight into the HttpOnly cookie, and
// replies with display identity only. `sessionToken` is never in the response
// body, never in a URL and never readable by script.
//
// The one-browser rule runs inside the backend's atomic redeem — revoking the
// previous browser and creating this one — so by the time this handler returns
// 201 the old session is already dead and its `webForceLoggedOut` has been
// pushed on the existing realtime connection.

import { NextResponse, type NextRequest } from "next/server";
import { isWebLinkToken } from "@wpt/shared";
import { failureResponse, isBackendConfigured, setSessionCookie, webLinkApi } from "../../../lib/web-link-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isBackendConfigured()) {
    return NextResponse.json(
      { ok: false, error: "backend_unavailable", message: "The linking service is not configured. Please try again shortly." },
      { status: 503 },
    );
  }
  let body: { code?: unknown };
  try {
    body = (await req.json()) as { code?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid", message: "Malformed request." }, { status: 400 });
  }
  if (!isWebLinkToken(body.code)) {
    return NextResponse.json(
      { ok: false, error: "invalid", message: "That login code is malformed. Please try again." },
      { status: 400 },
    );
  }
  try {
    const res = await webLinkApi().redeemLink(body.code);
    if (!res.ok) {
      const failed = failureResponse(res);
      return NextResponse.json(failed.body, { status: failed.httpStatus });
    }
    return NextResponse.json(
      {
        ok: true,
        userId: res.userId,
        accountName: res.accountName,
        deviceId: res.deviceId,
        webSessionId: res.webSessionId,
      },
      { status: 201, headers: { "Set-Cookie": setSessionCookie(res.sessionToken) } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "backend_unavailable", message: "The linking service is unavailable right now. Please try again." },
      { status: 503 },
    );
  }
}
