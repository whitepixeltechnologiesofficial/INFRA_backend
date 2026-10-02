// Web-link + web-session API routes (Sprint 3, R1.1–R1.9).
//
// Mounted by index.ts under /api/<API_VERSION>. The Web client reaches these
// through the Next.js BFF (which holds the HttpOnly cookie); the mobile app
// reaches them directly with its JWT. The backend is the authority.
//
// Public surface (anonymous, rate-limited, and deliberately narrow):
//   POST /web-link/register   the browser's own token + public identity
//   POST /web-link/redeem     spend a pushed code for a Web session
// Everything else requires either a mobile JWT (validate/approve/devices) or a
// live Web session (status/logout/ticket).

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWebSession } from "../middleware/web-session.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { getWebLinkService, type WebLinkService } from "../web-link/service.js";
import { resolveAccountByPhone } from "../accounts/account-lookup.js";
import { WEB_LINK_ERROR_MESSAGES } from "@wpt/shared";

const router: Router = Router();
// Resolved per request (see getWebLinkService) so the handler never pins a
// service to a store instance that has since been replaced.
const service = (): WebLinkService => getWebLinkService();

// ── Rate limiting: register + redeem are anonymous, so they're the spam surface.
const registerLimiter = rateLimit({
  maxRequests: 10,
  windowMs: 60_000,
  keyFn: (req) => `weblink:register:${req.ip ?? "unknown"}`,
});
const redeemLimiter = rateLimit({
  maxRequests: 30,
  windowMs: 60_000,
  keyFn: (req) => `weblink:redeem:${req.ip ?? "unknown"}`,
});

function rejectionStatus(error: string): number {
  if (error === "expired" || error === "already_used") return 410;
  if (error === "not_authorized") return 401;
  return 400;
}

function sendRejection(res: Response, r: { error: string; message: string }): void {
  res.status(rejectionStatus(r.error)).json({ ok: false, error: r.error, message: r.message });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /web-link/register  (public, rate-limited)
// ─────────────────────────────────────────────────────────────────────────────
// Step 1 of the protocol: the BROWSER generated the token with
// crypto.getRandomValues and generated a public identity with @wpt/crypto.
// Neither the raw token nor anything secret is persisted — only SHA-256(token).
// The response is the browser's proof that registration succeeded, and the QR
// is only rendered after this arrives.
router.post(
  "/web-link/register",
  registerLimiter,
  async (req: Request, res: Response) => {
    try {
      const result = await service().registerWithTicket({
        token: req.body?.token,
        identity: req.body?.identity,
      });
      if (!result.ok) {
        sendRejection(res, result);
        return;
      }
      res.status(201).json({
        ok: true,
        linkId: result.linkId,
        qrPayload: result.qrPayload,
        expiresAt: result.expiresAt,
        ttlMs: result.ttlMs,
        linkTicket: result.linkTicket,
      });
    } catch (err) {
      // Registration used to fail here with a bare `catch {}` that answered 500
      // and logged NOTHING, so a missing signing key looked identical to a
      // hundred other faults and surfaced to the browser as the bare string
      // "register_failed". Log the real cause server-side and still refuse to
      // render a QR (the client only draws one on ok:true).
      //
      // Only the error NAME and message are recorded: never the token, never the
      // ticket, never the identity bundle.
      console.error("[web-link/register] registration failed:", err instanceof Error ? err.message : String(err));
      res.status(500).json({
        ok: false,
        error: "register_failed",
        message: "We couldn't create a login code. Please try again.",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /web-link/:token/validate  (authenticated mobile)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/web-link/:token/validate",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const result = await service().validate(req.params.token as string);
      if (!result.ok) {
        sendRejection(res, result);
        return;
      }
      res.json({
        ok: true,
        valid: true,
        accountName: result.accountName,
        expiresAt: result.expiresAt,
      });
    } catch {
      res.status(500).json({ ok: false, error: "invalid", message: WEB_LINK_ERROR_MESSAGES.invalid });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /web-link/:token/approve  (authenticated mobile)
// ─────────────────────────────────────────────────────────────────────────────
// Binds the link to THIS authenticated mobile user (from the JWT, never from the
// body — IDOR-proof), then pushes the hand-off to the waiting browser.
router.post(
  "/web-link/:token/approve",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const result = await service().approve(req.params.token as string, {
        mobileUserId: res.locals.auth!.sub,
        mobileDeviceId: res.locals.auth!.deviceId,
        accountName: typeof req.body?.accountName === "string" ? req.body.accountName : undefined,
      });
      if (!result.ok) {
        sendRejection(res, result);
        return;
      }
      res.json({ ok: true, approved: true });
    } catch {
      res.status(500).json({ ok: false, error: "invalid", message: WEB_LINK_ERROR_MESSAGES.invalid });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /web-link/redeem  (public, rate-limited)
// ─────────────────────────────────────────────────────────────────────────────
// Called server-to-server by the BFF, never by browser JavaScript. The
// sessionToken in the response is written straight into an HttpOnly cookie by
// the caller and is never relayed onward. The redemption code is stored only as
// a digest, so a leaked database cannot be replayed through this endpoint.
router.post(
  "/web-link/redeem",
  redeemLimiter,
  async (req: Request, res: Response) => {
    try {
      const result = await service().redeem(req.body?.code);
      if (!result.ok) {
        sendRejection(res, result);
        return;
      }
      res.status(201).json({
        ok: true,
        sessionToken: result.sessionToken,
        userId: result.userId,
        deviceId: result.deviceId,
        webSessionId: result.webSessionId,
        accountName: result.accountName,
        expiresAt: result.expiresAt,
      });
    } catch {
      res.status(500).json({ ok: false, error: "redeem_failed" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /web-session/status  (web session, cookie-gated via BFF)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/web-session/status",
  requireWebSession,
  async (_req: Request, res: Response) => {
    res.json({ ok: true, ...res.locals.webSession! });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /web-session/logout  (web session) — server-side revocation
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/web-session/logout",
  requireWebSession,
  async (req: Request, res: Response) => {
    try {
      const token = readBearer(req);
      if (!token) {
        res.status(401).json({ ok: false });
        return;
      }
      await service().logout(token);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /web-session/ticket  (web session → short-lived socket ticket)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/web-session/ticket",
  requireWebSession,
  async (req: Request, res: Response) => {
    try {
      const token = readBearer(req);
      if (!token) {
        res.status(401).json({ ok: false });
        return;
      }
      const result = await service().realtimeTicket(token);
      if (!result.ok) {
        res.status(401).json({ ok: false });
        return;
      }
      res.json({ ok: true, ticket: result.ticket });
    } catch {
      res.status(500).json({ ok: false });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /web-link/devices  (authenticated mobile — list linked web browsers)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/web-link/devices",
  requireAuth,
  async (_req: Request, res: Response) => {
    try {
      const { devices } = await service().listDevices(res.locals.auth!.sub);
      res.json({ ok: true, devices });
    } catch {
      res.status(500).json({ ok: false, error: "list_failed" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /web-link/devices/:deviceId  (authenticated mobile — revoke)
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  "/web-link/devices/:deviceId",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const deviceId = req.params.deviceId as string;
      if (!deviceId) {
        res.status(400).json({ ok: false, error: "invalid", message: "Missing device id." });
        return;
      }
      const result = await service().revokeDevice(res.locals.auth!.sub, deviceId);
      if (!result.ok) {
        res.status(404).json({ ok: false, error: result.error, message: result.message });
        return;
      }
      res.json({ ok: true, revokedAt: result.revokedAt });
    } catch {
      res.status(500).json({ ok: false, error: "revoke_failed" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// WEB-R1.1 — dev/test triggers. NOT MOUNTED IN PRODUCTION.
//
// The linking protocol is real, not a mock, so the only thing a developer
// without a physical phone could not do was *initiate* the phone side of it
// (`approve` requires a mobile JWT) or move it to a chosen instant (the 60s TTL).
// These four routes close exactly that gap and delegate straight to the same
// service functions the real handlers use — no second state machine, no second
// store, no duplicated protocol.
//
// They are registered ONLY when NODE_ENV !== "production", and they are NOT part
// of the shared contract: nothing in apps/web or packages/* depends on them, so
// BE-6.1 does not have to implement a single one of them.
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== "production") {
  /** Reject the whole dev surface when it is somehow reached in production. */
  const devOnly = (_req: Request, res: Response, next: () => void): void => {
    if (process.env.NODE_ENV === "production") {
      res.status(404).json({ ok: false, error: "not_found" });
      return;
    }
    next();
  };

  // POST /web-link/_dev/scan — stand in for "phone scans the QR and approves".
  // The response is the approve result: NO credential. The redemption code is
  // PUSHED to `link:<hash(token)>` exactly as it is in production.
  //
  // `deliverInline: true` is the single opt-out from that, and it exists for one
  // caller: a headless dev client that has no browser socket to receive the push
  // on. It changes only HOW the caller learns the code it was always going to be
  // handed — the same single-use 60s bearer, over the same server-to-server hop
  // the BFF uses, never a session credential and never anything a browser can
  // act on. The default is still credential-free, so the "the scan response
  // carries no credential" invariant continues to hold for every existing caller
  // (asserted by web-r-1-1-verify).
  //
  // IDENTITY: pass `phoneNumber` and the account is resolved HERE, from the real
  // user store (`users.phone_number` -> id + name, the same lookup OTP verify
  // does). A caller may not name a different account on that path — any
  // `mobileUserId`/`accountName` in the body is ignored — so the account a Web
  // session is issued for is always one that actually exists in the backend,
  // never one a frontend asserted. There is no fallback account: an unknown
  // number is refused and nothing is approved.
  //
  // `mobileUserId` remains supported as the explicit form used by harnesses and
  // by tests that need to drive a specific account directly (its account is a
  // deliberate test input, not a Web client's claim about a real user).
  router.post(
    "/web-link/_dev/scan",
    devOnly,
    async (req: Request, res: Response) => {
      const { token, mobileUserId, mobileDeviceId, accountName, phoneNumber, deliverInline } = (req.body ?? {}) as {
        token?: string;
        mobileUserId?: string;
        mobileDeviceId?: string;
        accountName?: string;
        phoneNumber?: string;
        deliverInline?: boolean;
      };
      if (!token) {
        res.status(400).json({ ok: false, error: "invalid", message: "token is required." });
        return;
      }

      let approver: { mobileUserId: string; mobileDeviceId: string; accountName?: string };
      if (phoneNumber !== undefined) {
        const resolved = await resolveAccountByPhone(phoneNumber);
        if (!resolved.ok) {
          res.status(resolved.error === "invalid_phone" ? 400 : 404).json({
            ok: false,
            error: resolved.error,
            message: resolved.message,
          });
          return;
        }
        approver = {
          mobileUserId: resolved.account.userId,
          mobileDeviceId: mobileDeviceId || "dev-scan",
          accountName: resolved.account.accountName,
        };
      } else {
        if (!mobileUserId || !mobileDeviceId) {
          res.status(400).json({ ok: false, error: "invalid", message: "token, mobileUserId and mobileDeviceId are required." });
          return;
        }
        approver = { mobileUserId, mobileDeviceId, accountName };
      }

      const result = await service().approve(token, approver);
      if (!result.ok) {
        sendRejection(res, result);
        return;
      }
      res.json({
        ok: true,
        approved: true,
        userId: result.userId,
        webDeviceId: result.webDeviceId,
        ...(deliverInline === true
          ? { code: result.code, codeExpiresAt: result.codeExpiresAt, linkExpiresAt: result.linkExpiresAt }
          : {}),
      });
    },
  );

  // POST /web-link/_dev/force-logout — stand in for a new-phone login (R1.9).
  // Revokes every WEB session for the account and pushes webForceLoggedOut.
  //
  // R1.9 is the most destructive operation in this router, so it is gated exactly
  // like R1.3/R1.4: `requireAuth`, and the account comes from the authenticated
  // mobile JWT in `res.locals.auth` — NEVER from a body field. A body-sourced
  // `userId` here is an IDOR: any logged-in phone could end every linked browser
  // of any account it named, and `devOnly` does not help, because development
  // builds are the ones being talked to. This route previously took `userId`
  // from the body and carried no `requireAuth` at all, so an unauthenticated
  // caller could do the same.
  //
  // `reason` stays body-supplied: it is notice text for the browser's message,
  // not an authority input, and QA needs to exercise reasons. Same reasoning as
  // R1.4's body-sourced `accountName`.
  router.post(
    "/web-link/_dev/force-logout",
    devOnly,
    requireAuth,
    async (_req: Request, res: Response) => {
      const { reason } = (_req.body ?? {}) as { reason?: string };
      const userId = res.locals.auth!.sub;
      if (!userId) {
        res.status(400).json({ ok: false, error: "invalid", message: "userId is required." });
        return;
      }
      const { revokedCount } = await service().revokeUserWebSessions(userId, reason ?? "new_phone_login");
      res.json({ ok: true, revokedCount });
    },
  );

  // POST /web-link/_dev/phone-presence — the phone went offline / came back.
  // Deliberately touches NO session state: R1.4 requires the Web session to
  // survive a phone that is merely unreachable. The state itself belongs to the
  // chat relay (its existing mockPhoneStatus push), so all this does is report
  // that a change was requested.
  router.post(
    "/web-link/_dev/phone-presence",
    devOnly,
    async (req: Request, res: Response) => {
      const { userId, online } = (req.body ?? {}) as { userId?: string; online?: boolean };
      if (!userId || typeof online !== "boolean") {
        res.status(400).json({ ok: false, error: "invalid", message: "userId and boolean online are required." });
        return;
      }
      res.json({ ok: true, userId, online, sessionAffected: false });
    },
  );
}

function readBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.slice(7);
  return null;
}

export default router;
