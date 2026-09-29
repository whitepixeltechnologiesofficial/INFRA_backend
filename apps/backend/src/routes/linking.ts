/**
 * BE-6.1 — Web linking endpoints (link-on-scan, log-off).
 *
 *   POST /linking/scan     phone (authenticated) confirms a scanned QR token
 *   POST /linking/logoff   Web (authenticated as its own device row) logs itself off
 *
 * The third leg of BE-6.1 — the linking WebSocket channel where Web
 * registers its token + identity bundle, and where it receives the
 * issued tokens — lives in ../ws/linking-registry.ts and is wired up
 * in app.ts (it's a socket namespace, not an HTTP route).
 *
 * SCOPE GUARDRAILS (from the card):
 *   - This is explicitly NOT the §7.3 new-device handoff
 *     (routes/onboarding.ts's executeHandoffTransaction). That
 *     revokes ALL of a user's sessions; this only ever touches
 *     device_type='web' rows. The phone's own session is never
 *     revoked by anything in this file.
 *   - No separate sessions table for Web — reuses DB-2.6 `sessions`
 *     exactly as the phone does, scoped by deviceId.
 *   - /scan requires a valid access token (LOGIN-3.1/3.2 utilities) —
 *     no unauthenticated link requests.
 *
 * OPEN ITEM for the second reviewer (identity keys, §8.6 — mandatory
 * extra review per the card): the Tech Arch Document itself isn't
 * available in this repo/project (same gap already flagged in
 * packages/shared/src/types/index.ts's header comment), so
 * identityPublicKey/signingPublicKey are stored using the exact same
 * devices columns every other device type already uses, and "TAD
 * decision 22 (re-link reuses existing identity)" is implemented here
 * as "there is at most one non-revoked device_type='web' row per
 * account at any time" — confirm both against the real TAD text.
 */

import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { devices } from "../db/devices-schema.js";
import { sessions } from "../db/sessions-schema.js";
import { issueAccessToken, issueRefreshToken, revokeSession } from "../auth/index.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import {
  tryConsumeLinkingToken,
  rollbackLinkingConsumption,
  pushLinkedPayload,
  isPlausibleLinkingToken,
} from "../ws/linking-registry.js";
import { pushForceLogoutToDevice, disconnectDevice } from "../ws/socket-registry.js";

const router: Router = Router();

// ──────────────────────────────────────────────────
// POST /linking/scan
//
// Body: { token: string }  — the token scanned from Web's QR code.
//
// SECURITY: requireAuth proves the caller owns the account being
// linked to (no unauthenticated link requests, per the card). Rate
// limited per-account to blunt token-guessing attempts — the 60s TTL
// already makes guessing infeasible, this is defense in depth.
// ──────────────────────────────────────────────────
router.post(
  "/scan",
  requireAuth,
  rateLimit({
    maxRequests: 10,
    windowMs: 60_000,
    keyFn: (req) => `linking-scan:${req.res?.locals.auth?.sub ?? req.ip ?? "unknown"}`,
  }),
  async (req: Request, res: Response) => {
    const { token } = req.body as { token?: string };
    const userId = res.locals.auth!.sub;

    if (!isPlausibleLinkingToken(token)) {
      res.status(400).json({ error: "INVALID_TOKEN" });
      return;
    }

    // Synchronous check-and-lock, no `await` before it — see
    // tryConsumeLinkingToken's doc comment for why this is what makes
    // a reused/concurrent-scanned token get rejected instead of racing
    // through twice. Handles both NOT ALLOWED cases: unknown/expired
    // token (never registered, or older than 60s) and reuse (already
    // locked by a prior successful or in-flight scan) — both return
    // the same terminal response to the caller.
    const entry = tryConsumeLinkingToken(token);
    if (!entry) {
      res.status(410).json({ error: "TOKEN_INVALID_OR_EXPIRED" });
      return;
    }

    try {
      const db = getDb();
      const result = await db.transaction(async (tx) => {
        // TAD decision 22 — re-linking reuses the existing identity:
        // at most one non-revoked web device per account, so find and
        // revoke it (if any) in the SAME transaction as the insert.
        const [existingWeb] = await tx
          .select({ id: devices.id })
          .from(devices)
          .where(
            and(
              eq(devices.userId, userId),
              eq(devices.deviceType, "web"),
              isNull(devices.revokedAt),
            ),
          )
          .limit(1);

        if (existingWeb) {
          await tx
            .update(devices)
            .set({ revokedAt: new Date() })
            .where(eq(devices.id, existingWeb.id));

          // Only the WEB session is revoked here — never the phone's.
          await tx
            .update(sessions)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(sessions.userId, userId),
                eq(sessions.deviceId, existingWeb.id),
                isNull(sessions.revokedAt),
              ),
            );
        }

        const newDeviceId = randomUUID();
        await tx.insert(devices).values({
          id: newDeviceId,
          userId,
          deviceType: "web",
          platform: "web",
          identityPublicKey: entry.identity.identityPublicKey,
          signingPublicKey: entry.identity.signingPublicKey ?? null,
        });

        const { refreshToken, sessionId } = await issueRefreshToken({
          userId,
          deviceId: newDeviceId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- transaction type mismatch with issueRefreshToken's db param (same pattern as routes/onboarding.ts)
          db: tx as any,
        });
        const accessToken = await issueAccessToken({
          userId,
          deviceId: newDeviceId,
          sessionId,
        });

        return {
          newDeviceId,
          accessToken,
          refreshToken,
          sessionId,
          oldWebDeviceId: existingWeb?.id ?? null,
        };
      });

      // Push AFTER commit, never from inside the transaction — if the
      // process died between commit and push, Web's reconnect-with-
      // same-token path in linking-registry.ts still recovers it
      // within the TTL. Common mistake to avoid: this push is what
      // tells Web — Web must never have to poll for it.
      pushLinkedPayload(token, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        userId,
        deviceId: result.newDeviceId,
        sessionId: result.sessionId,
      });

      // Kick the PREVIOUS browser only — never the phone, never any
      // other device. This is the one-Web-session-per-account decision
      // (27 Sep, Samson): notify then hard-close its socket.
      if (result.oldWebDeviceId) {
        pushForceLogoutToDevice(userId, result.oldWebDeviceId);
        disconnectDevice(userId, result.oldWebDeviceId);
      }

      res.json({ ok: true, linked: true, deviceId: result.newDeviceId });
    } catch (err) {
      // The transaction didn't commit — nothing changed. Unlock the
      // token so the SAME QR can be retried within whatever's left of
      // its TTL, instead of the link silently half-failing.
      rollbackLinkingConsumption(token);
      console.error("POST /linking/scan error", err);
      res.status(500).json({ error: "LINK_FAILED" });
    }
  },
);

// ──────────────────────────────────────────────────
// POST /linking/logoff
//
// Called by WEB itself, authenticated with the access token issued by
// /scan above. Only ever revokes the CALLER's own device/session — a
// web session can't log off any device but itself.
// ──────────────────────────────────────────────────
router.post("/logoff", requireAuth, async (req: Request, res: Response) => {
  const { sub: userId, deviceId, sid: sessionId } = res.locals.auth!;

  try {
    const db = getDb();

    const [device] = await db
      .select({ id: devices.id, deviceType: devices.deviceType, revokedAt: devices.revokedAt })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
      .limit(1);

    if (!device) {
      res.status(404).json({ error: "DEVICE_NOT_FOUND" });
      return;
    }

    // This endpoint is Web's own log-off — guard against a non-web
    // device (e.g. a phone) accidentally calling it and revoking
    // itself through the wrong path.
    if (device.deviceType !== "web") {
      res.status(403).json({ error: "NOT_A_WEB_SESSION" });
      return;
    }

    if (!device.revokedAt) {
      await db
        .update(devices)
        .set({ revokedAt: new Date() })
        .where(eq(devices.id, deviceId));
    }

    await revokeSession(sessionId);

    // "Closes its socket" — an event alone isn't enough if the client
    // is unresponsive; force-close the live connection server-side.
    disconnectDevice(userId, deviceId);

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /linking/logoff error", err);
    res.status(500).json({ error: "LOGOFF_FAILED" });
  }
});

export default router;
