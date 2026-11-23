import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createServer, type Server as HttpServer } from "node:http";
import { Server as SocketServer } from "socket.io";
import { API_VERSION, SOCKET_NAMESPACE } from "@wpt/shared";
import onboardingRoutes from "./routes/onboarding.js";
import profileRoutes from "./routes/profile.js";
import debugRoutes from "./routes/debug.js";
import blocksRoutes from "./routes/blocks.js";
import reportsRoutes from "./routes/reports.js";
import moderationRoutes from "./routes/moderation.js";
import relayRoutes from "./routes/relay.js";
import messageStatusRoutes from "./routes/message-status.js";
import prekeysRoutes from "./routes/prekeys.js";
import linkingRoutes from "./routes/linking.js";
import contactsRoutes from "./routes/contacts.js";
import pushRoutes from "./routes/push.js";
import { drainQueuedMessages } from "./ws/offline-drain.js";
import {
  initSocketRegistry,
  registerSocket,
  unregisterSocket,
} from "./ws/socket-registry.js";
import {
  initLinkingNamespace,
  registerLinkingSocket,
  unregisterLinkingSocket,
  isPlausibleLinkingToken,
} from "./ws/linking-registry.js";
import { verifyAccessToken } from "./auth/jwt.js";
import { eq } from "drizzle-orm";
import { getDb } from "./db/index.js";
import { sessions } from "./db/sessions-schema.js";

export type BackendServer = {
  httpServer: HttpServer;
  io: SocketServer;
};

/**
 * Builds the Express app + Socket.io server. Configuration comes from
 * the environment (DATABASE_URL, JWT_SECRET, CORS_ORIGIN), which is set
 * either by dotenv (dev entry) or by the embedded entry point before
 * calling this factory.
 *
 * Deliberately does NOT `listen()` — callers decide the bind address.
 */
export function createApp(): BackendServer {
  const app = express();

  // ── Security headers ──
  app.use(helmet());

  // ── CORS: never wildcard in production ──
  const allowedOrigins = (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: allowedOrigins.length > 0 ? allowedOrigins : false,
      methods: ["GET", "POST"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );

  // ── Body parsing with size limit (100 KB max) ──
  app.use(express.json({ limit: "100kb" }));

  app.get(`/api/${API_VERSION}/health`, (_req, res) => {
    res.json({ ok: true });
  });

  app.use(`/api/${API_VERSION}/onboarding`, onboardingRoutes);
  app.use(`/api/${API_VERSION}/profile`, profileRoutes);
  app.use(`/api/${API_VERSION}/debug`, debugRoutes);
  app.use(`/api/${API_VERSION}/blocks`, blocksRoutes);
  app.use(`/api/${API_VERSION}/reports`, reportsRoutes);
  app.use(`/api/${API_VERSION}/moderation`, moderationRoutes);
  app.use(`/api/${API_VERSION}/relay/status`, messageStatusRoutes);
  app.use(`/api/${API_VERSION}/relay`, relayRoutes);
  app.use(`/api/${API_VERSION}/prekeys`, prekeysRoutes);
  app.use(`/api/${API_VERSION}/linking`, linkingRoutes);
  app.use(`/api/${API_VERSION}/contacts`, contactsRoutes);
  app.use(`/api/${API_VERSION}/push`, pushRoutes);

  const httpServer = createServer(app);

  const io = new SocketServer(httpServer, {
    path: SOCKET_NAMESPACE,
  });

  initSocketRegistry(io);

  // ── BE-6.1: Web linking channel ──
  //
  // A SEPARATE namespace, deliberately with NO auth middleware: Web has
  // no account yet when it opens this socket (that's the whole point —
  // it's how Web gets its first credentials). socket.io only runs
  // io.use() below against the default "/" namespace, so this namespace
  // is unaffected by it and the authenticated flow below is unaffected
  // by this. Security here comes from the linking token itself
  // (high-entropy, single-use, server-stamped 60s TTL) rather than from
  // request-level auth — see ws/linking-registry.ts for the full model.
  const linkingNamespace = io.of("/linking");
  initLinkingNamespace(linkingNamespace);

  linkingNamespace.on("connection", (socket) => {
    socket.on(
      "register",
      (
        data: { token?: string; identityPublicKey?: string; signingPublicKey?: string } | undefined,
        ack?: (response: { ok: boolean; error?: string }) => void,
      ) => {
        const token = data?.token;
        const identityPublicKey = data?.identityPublicKey;
        const signingPublicKey = data?.signingPublicKey;

        if (!isPlausibleLinkingToken(token) || typeof identityPublicKey !== "string" || !identityPublicKey) {
          ack?.({ ok: false, error: "INVALID_REGISTRATION" });
          return;
        }

        const { deliveredPayload } = registerLinkingSocket(socket, token, {
          identityPublicKey,
          signingPublicKey,
        });

        ack?.({ ok: true });

        // Reconnect-within-TTL case: the phone already finished linking
        // while this socket was disconnected — deliver immediately
        // instead of making Web wait for a push that already happened.
        if (deliveredPayload) {
          socket.emit("accountLinked", deliveredPayload);
        }
      },
    );

    socket.on("disconnect", () => {
      unregisterLinkingSocket(socket);
    });
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    const userId = socket.handshake.auth?.userId as string | undefined;
    const deviceId = socket.handshake.auth?.deviceId as string | undefined;

    if (!token || !userId || !deviceId) {
      next(new Error("Authentication required"));
      return;
    }

    try {
      const payload = await verifyAccessToken(token);
      if (payload.sub !== userId) {
        next(new Error("Token userId mismatch"));
        return;
      }
      // The socket must claim the exact device that the token was issued to.
      if (typeof payload.deviceId === "string" && payload.deviceId !== deviceId) {
        next(new Error("Token deviceId mismatch"));
        return;
      }

      // TAD §9.5 requires a connection-time revocation check IN ADDITION to the
      // 1h token expiry. Without this, a socket that authenticated before a
      // force-logout stays connected and keeps receiving messages until its
      // access token expires — a 1-hour window on every logout.
      const db = getDb();
      const [session] = await db
        .select({ revokedAt: sessions.revokedAt, userId: sessions.userId })
        .from(sessions)
        .where(eq(sessions.id, payload.sid))
        .limit(1);

      if (!session) {
        next(new Error("Session not found"));
        return;
      }
      if (session.revokedAt !== null) {
        next(new Error("Session revoked"));
        return;
      }
      if (session.userId !== payload.sub) {
        next(new Error("Session userId mismatch"));
        return;
      }

      next();
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Session")) {
        next(err);
        return;
      }
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.handshake.auth?.userId as string;
    const deviceId = socket.handshake.auth?.deviceId as string;

    registerSocket(socket, userId, deviceId);

    // BE-5.6: the device is (re)connected -- push everything queued for it while it was
    // offline. Registered first, so a message sent mid-drain is still live-pushed (the
    // client dedupes by message id).
    void drainQueuedMessages(socket, userId, deviceId).catch(() => {
      console.error("BE-5.6 queue drain failed");
    });

    socket.on("disconnect", () => {
      unregisterSocket(socket, userId);
    });
  });

  return { httpServer, io };
}
