// Web-session authentication middleware.
//
// The Web client talks to the backend exclusively through the Next.js BFF,
// which holds the web-session token in an HttpOnly cookie and forwards it as
// `Authorization: Bearer <webSessionToken>`. This middleware validates that
// token against the store on EVERY request — revocation and expiry are
// therefore effective immediately at the backend, not merely client-side.

import type { Request, Response, NextFunction } from "express";
import { secureHash } from "../web-link/crypto.js";
import { getWebLinkStore } from "../web-link/store.js";
import { isWebSessionActive } from "../web-link/core.js";

export interface WebSessionAuth {
  userId: string;
  deviceId: string;
  webSessionId: string;
  /** ISO server-side expiry — the browser re-links once it passes. */
  expiresAt: string;
}

declare module "express-serve-static-core" {
  interface Locals {
    webSession?: WebSessionAuth;
  }
}

export async function requireWebSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "MISSING_WEB_SESSION" });
    return;
  }

  const token = header.slice(7);
  if (!token) {
    res.status(401).json({ error: "EMPTY_WEB_SESSION" });
    return;
  }

  try {
    const store = getWebLinkStore();
    const session = await store.getSessionByTokenHash(secureHash(token));
    if (!session || !isWebSessionActive(session, new Date())) {
      res.status(401).json({ error: "WEB_SESSION_INVALID" });
      return;
    }

    await store.updateSession(session.id, { lastSeenAt: new Date().toISOString() });

    res.locals.webSession = {
      userId: session.userId,
      deviceId: session.deviceId,
      webSessionId: session.id,
      expiresAt: session.expiresAt,
    };
    next();
  } catch {
    res.status(401).json({ error: "WEB_SESSION_INVALID" });
  }
}