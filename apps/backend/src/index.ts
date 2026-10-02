import "dotenv/config";
<<<<<<< HEAD
import { createApp } from "./app.js";
import { assertDbTransport } from "./db/index.js";
=======
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { API_VERSION, SOCKET_NAMESPACE, WEB_LINK_EVENTS } from "@wpt/shared";
import onboardingRoutes from "./routes/onboarding.js";
import profileRoutes from "./routes/profile.js";
import pushRoutes from "./routes/push.js";
import messagesRoutes from "./routes/messages.js";
import webLinkRoutes from "./routes/web-link.js";
import { bindIo } from "./messages/providers.js";
import {
  initSocketRegistry,
  registerSocket,
  unregisterSocket,
} from "./ws/socket-registry.js";
import {
  initWebSocketRegistry,
  registerLinkSocket,
  registerWebSocket,
  unregisterLinkSocket,
  unregisterWebSocket,
} from "./web-link/socket-registry.js";
import { verifyAccessToken } from "./auth/jwt.js";
import { verifyLinkTicket, verifyRealtimeTicket } from "./web-link/ticket.js";
import { getWebLinkService } from "./web-link/service.js";
import { assertRuntimeConfig } from "./config.js";

// Fail BEFORE listening. A missing signing key used to surface as an opaque
// 500 from one endpoint; see src/config.ts for the incident.
assertRuntimeConfig();

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
    methods: ["GET", "POST", "DELETE"],
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
app.use(`/api/${API_VERSION}/push`, pushRoutes);

// Sprint 3 — web-linking + web-session lifecycle (R1.1–R1.8).
// The Web client reaches these through the Next.js BFF; the mobile app talks
// to them directly with its JWT. Backend is the authority.
app.use(`/api/${API_VERSION}`, webLinkRoutes);

// BE-5.5 — realtime side-channel endpoints at the canonical client contract
// (/api/messages/read, /api/messages/typing from packages/shared/realtime.ts).
app.use("/api", messagesRoutes);

const httpServer = createServer(app);

const io = new Server(httpServer, {
  path: SOCKET_NAMESPACE,
});

initSocketRegistry(io);
initWebSocketRegistry(io);
bindIo(io);

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  const userId = socket.handshake.auth?.userId as string | undefined;
  const deviceId = socket.handshake.auth?.deviceId as string | undefined;
  const ticket = socket.handshake.auth?.ticket as string | undefined;
  const linkTicket = socket.handshake.auth?.linkTicket as string | undefined;

  // PRE-AUTHENTICATION: a browser that has just registered a linking token.
  // The link ticket authorises joining exactly one room — `link:<sha256(token)>`
  // — which is how the backend PUSHES the login hand-off to that browser and
  // removes "are you logged in yet?" polling from the flow entirely.
  if (typeof linkTicket === "string" && linkTicket.length > 0) {
    try {
      const t = await verifyLinkTicket(linkTicket);
      socket.data.link = { linkId: t.linkId };
      next();
      return;
    } catch {
      next(new Error("Invalid link ticket"));
      return;
    }
  }

  // Sprint 3 — Web clients authenticate with a SHORT-LIVED realtime ticket
  // (60s, aud-restricted to wpt-realtime), never a long-lived web-session
  // token, and never user-supplied strings. Ticket transport keeps the
  // long-lived credential out of socket frames entirely.
  if (typeof ticket === "string" && ticket.length > 0) {
    try {
      const t = await verifyRealtimeTicket(ticket);
      if ((userId && t.sub !== userId) || (deviceId && t.deviceId !== deviceId)) {
        next(new Error("Ticket identity mismatch"));
        return;
      }
      socket.data.webSession = {
        userId: t.sub,
        deviceId: t.deviceId,
        webSessionId: t.webSessionId,
      };
      next();
      return;
    } catch {
      next(new Error("Invalid ticket"));
      return;
    }
  }

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
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  // ── pre-auth link registration socket ──────────────────────────────────────
  const link = socket.data.link as { linkId: string } | undefined;
  if (link) {
    registerLinkSocket(socket, link.linkId);
    // If the phone already approved while this socket was down, hand the
    // decision over now instead of making the browser wait for the next scan.
    // Resolved per connection so it always tracks the current store.
    void getWebLinkService().reissueLogin(link.linkId).then((push) => {
      if (push) socket.emit(WEB_LINK_EVENTS.login, push);
    });
    socket.on("disconnect", () => {
      unregisterLinkSocket(socket, link.linkId);
    });
    return;
  }

  const web = socket.data.webSession as
    | { userId: string; deviceId: string; webSessionId: string }
    | undefined;

  if (web) {
    registerWebSocket(socket, web.userId, web.deviceId, web.webSessionId);
    socket.on("disconnect", () => {
      unregisterWebSocket(socket, web.userId);
    });
    return;
  }

  const userId = socket.handshake.auth?.userId as string;
  const deviceId = socket.handshake.auth?.deviceId as string;

  registerSocket(socket, userId, deviceId);

  // BE-5.5 — join the per-user room so realtime broadcasts (read receipts,
  // typing indicators) reach every device of the user via `user:<id>`.
  socket.join(`user:${userId}`);

  socket.on("disconnect", () => {
    unregisterSocket(socket, userId);
  });
});
>>>>>>> 4fd3746 ( web QR linking and chat fixtures)

const PORT = process.env.PORT ?? 4000;

const { httpServer } = createApp();
httpServer.listen(PORT, () => {
  console.log(`@wpt/backend listening on :${PORT}`);
});

assertDbTransport().catch((err) => {
  console.error(`[db] transport check failed: ${(err as Error).message}`);
  process.exit(1);
});