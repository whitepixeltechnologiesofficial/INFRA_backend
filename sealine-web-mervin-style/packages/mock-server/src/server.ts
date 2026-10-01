import http from "node:http";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import type {
  ApiErrorBody,
  LinkingPushMessage,
  RegisterLinkingRequest,
  ScanLinkingRequest,
  LogoutRequest,
  RefreshRequest
} from "@wpt/shared";

const PORT = Number(process.env.LINKING_SERVER_PORT ?? 8787);

function getLanHosts(): string[] {
  const hosts: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
      if (!hosts.includes(entry.address)) hosts.push(entry.address);
    }
  }
  // Prefer normal private IPv4 addresses used by Wi-Fi/Ethernet.
  return hosts.sort((a, b) => {
    const score = (ip: string) =>
      /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 0 : 1;
    return score(a) - score(b);
  });
}

function getLanHost(): string {
  const configured = process.env.LINKING_SERVER_HOST?.trim();
  if (configured && configured !== "localhost" && configured !== "127.0.0.1") {
    return configured;
  }

  if (process.platform === "win32") {
    try {
      const value = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", "(Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway -and $_.IPv4Address} | Select-Object -First 1 -ExpandProperty IPv4Address | Select-Object -First 1).IPAddress"],
        { encoding: "utf8", windowsHide: true }
      ).trim();
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(value)) return value;
    } catch {
      // Fall through to interface discovery.
    }
  }

  return getLanHosts()[0] ?? "localhost";
}

function applyCors(res: http.ServerResponse) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

type Registration = {
  token: string;
  channelId: string;
  expiresAt: number;
  used: boolean;
  revoked: boolean;
  sockets: Set<WebSocket>;
  refreshToken?: string;
  accessToken?: string;
};

const registrations = new Map<string, Registration>();
const tokenToChannel = new Map<string, string>();

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function error(
  res: http.ServerResponse,
  status: number,
  code: ApiErrorBody["error"]["code"],
  message: string
) {
  json(res, status, { error: { code, message } } satisfies ApiErrorBody);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

function emit(registration: Registration, message: LinkingPushMessage) {
  const payload = JSON.stringify(message);
  for (const socket of registration.sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

function findRegistrationByToken(token: string) {
  const channelId = tokenToChannel.get(token);
  return channelId ? registrations.get(channelId) : undefined;
}

const server = http.createServer(async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, service: "wpt-linking-mock", port: PORT, lanHost: getLanHost(), lanHosts: getLanHosts() });
    }

    // A normal phone camera/browser opens the QR URL directly.
    // Serve the mobile confirmation page here so the user sees
    // “Link this account?” instead of a Route not found JSON error.
    if (req.method === "GET") {
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (requestUrl.pathname === "/link") {
        const token = requestUrl.searchParams.get("token") ?? "";
        const registration = token ? findRegistrationByToken(token) : undefined;
        if (!registration) {
          res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><body style="font-family:Arial,sans-serif;padding:32px"><h2>Invalid Sealine link</h2><p>This QR link was not found. Scan a fresh QR code.</p></body></html>`);
          return;
        }
        if (Date.now() >= registration.expiresAt) {
          res.writeHead(410, { "content-type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><body style="font-family:Arial,sans-serif;padding:32px"><h2>QR expired</h2><p>Go back to Sealine Web and scan the new QR code.</p></body></html>`);
          return;
        }
        const safeToken = JSON.stringify(token);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sealine</title></head>
<body style="margin:0;background:#f5f6f8;font-family:Arial,sans-serif;color:#111827">
<main style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box">
<section style="width:100%;max-width:420px;background:white;border-radius:22px;padding:32px;box-sizing:border-box;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.08)">
<div style="font-size:54px;margin-bottom:12px">🔗</div>
<h1 style="margin:0 0 12px;font-size:28px">Link this account?</h1>
<p style="color:#667085;line-height:1.5;margin:0 0 28px">This will link your Sealine mobile account to the Web session shown on your computer.</p>
<button id="approve" style="width:100%;border:0;border-radius:12px;padding:15px;background:#111827;color:white;font-size:16px;font-weight:700">Link this account</button>
<button id="cancel" style="width:100%;margin-top:10px;border:1px solid #d0d5dd;border-radius:12px;padding:15px;background:white;color:#111827;font-size:16px">Cancel</button>
<p id="status" style="margin-top:18px;color:#667085"></p>
</section></main>
<script>
const token=${safeToken};
const statusEl=document.getElementById('status');
const approve=document.getElementById('approve');
approve.onclick=async()=>{approve.disabled=true;approve.textContent='Linking…';statusEl.textContent='';try{const r=await fetch('/v1/linking/scan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,deviceId:'physical-phone'})});const data=await r.json();if(!r.ok)throw new Error(data?.error?.message||'Unable to link this account.');document.querySelector('section').innerHTML='<div style="font-size:54px">✓</div><h1>Account linked</h1><p style="color:#667085;line-height:1.5">Your Sealine account has been linked. You can return to the Web session.</p>';}catch(e){approve.disabled=false;approve.textContent='Link this account';statusEl.style.color='#b42318';statusEl.textContent=e.message;}};
document.getElementById('cancel').onclick=()=>{document.querySelector('section').innerHTML='<div style="font-size:54px">✓</div><h1>Cancelled</h1><p style="color:#667085">The Sealine account was not linked.</p>';};
</script></body></html>`);
        return;
      }
    }

    if (req.method !== "POST") {
      return error(res, 404, "INVALID_REQUEST", "Route not found.");
    }

    if (req.url === "/v1/linking/register") {
      const body = (await readBody(req)) as RegisterLinkingRequest;

      if (!body.token || body.ttlSeconds !== 60 || !body.identityBundle) {
        return error(res, 400, "INVALID_REQUEST", "Invalid linking registration.");
      }

      if (tokenToChannel.has(body.token)) {
        return error(res, 409, "TOKEN_REUSED", "This linking token is already registered.");
      }

      const channelId = randomUUID();
      const registration: Registration = {
        token: body.token,
        channelId,
        expiresAt: Date.now() + 60_000,
        used: false,
        revoked: false,
        sockets: new Set()
      };

      registrations.set(channelId, registration);
      tokenToChannel.set(body.token, channelId);

      return json(res, 200, {
        channelId,
        expiresAt: registration.expiresAt
      });
    }

    if (req.url === "/v1/linking/scan") {
      const body = (await readBody(req)) as ScanLinkingRequest;
      const registration = findRegistrationByToken(body.token);

      if (!registration) {
        return error(res, 404, "TOKEN_NOT_FOUND", "Linking QR token was not found.");
      }

      if (Date.now() >= registration.expiresAt) {
        return error(
          res,
          410,
          "TOKEN_EXPIRED",
          "Linking token expired. Refresh the QR code and scan the new token."
        );
      }

      if (registration.used || registration.revoked) {
        return error(
          res,
          409,
          "TOKEN_REUSED",
          "This linking token has already been used. Refresh the QR code."
        );
      }

      registration.used = true;
      registration.accessToken = `access_${randomUUID()}`;
      registration.refreshToken = `refresh_${randomUUID()}`;

      const message: LinkingPushMessage = {
        type: "tokens_issued",
        channelId: registration.channelId,
        sessionId: randomUUID(),
        accessToken: registration.accessToken,
        refreshToken: registration.refreshToken,
        issuedAt: Date.now()
      };

      queueMicrotask(() => emit(registration, message));

      // Deliberately does not return access/refresh tokens.
      return json(res, 200, {
        accepted: true,
        channelId: registration.channelId
      });
    }

    if (req.url === "/v1/linking/logout") {
      const body = (await readBody(req)) as LogoutRequest;
      const registration = registrations.get(body.channelId);

      if (!registration || registration.refreshToken !== body.refreshToken || registration.revoked) {
        return error(res, 401, "REFRESH_REVOKED", "The refresh token has been revoked.");
      }

      registration.revoked = true;
      registration.refreshToken = undefined;
      registration.accessToken = undefined;

      return json(res, 200, { revoked: true });
    }

    if (req.url === "/v1/linking/refresh") {
      const body = (await readBody(req)) as RefreshRequest;

      for (const registration of registrations.values()) {
        if (registration.refreshToken === body.refreshToken) {
          if (registration.revoked) {
            return error(res, 401, "SESSION_REVOKED", "This session has been revoked.");
          }

          registration.accessToken = `access_${randomUUID()}`;
          registration.refreshToken = `refresh_${randomUUID()}`;

          return json(res, 200, {
            accessToken: registration.accessToken,
            refreshToken: registration.refreshToken
          });
        }
      }

      return error(res, 401, "REFRESH_REVOKED", "The refresh token has been revoked.");
    }

    return error(res, 404, "INVALID_REQUEST", "Route not found.");
  } catch {
    return error(res, 400, "INVALID_REQUEST", "Invalid request.");
  }
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const channelId = url.searchParams.get("channelId");

  // A Web subscription uses the registered channel ID.
  const registration = channelId ? registrations.get(channelId) : undefined;

  // The mobile app first connects without a known Web channel and then
  // approves the QR by sending the token. The server resolves the token
  // to the Web channel and pushes tokens there.
  if (!registration && channelId !== "mobile-approval") {
    socket.close(1008, "Unknown channel");
    return;
  }

  if (registration) {
    registration.sockets.add(socket);
    socket.on("close", () => {
      registration.sockets.delete(socket);
    });
    return;
  }

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());

      if (message.type !== "mobile_approve" || typeof message.token !== "string") {
        socket.close(1008, "Invalid mobile approval");
        return;
      }

      const target = findRegistrationByToken(message.token);
      if (!target) {
        socket.send(JSON.stringify({
          type: "link_error",
          code: "TOKEN_NOT_FOUND",
          message: "Linking QR token was not found."
        }));
        socket.close();
        return;
      }

      if (Date.now() >= target.expiresAt) {
        socket.send(JSON.stringify({
          type: "link_error",
          code: "TOKEN_EXPIRED",
          message: "Linking token expired. Refresh the QR code."
        }));
        socket.close();
        return;
      }

      if (target.used || target.revoked) {
        socket.send(JSON.stringify({
          type: "link_error",
          code: "TOKEN_REUSED",
          message: "This QR has already been used."
        }));
        socket.close();
        return;
      }

      target.used = true;
      target.accessToken = `access_${randomUUID()}`;
      target.refreshToken = `refresh_${randomUUID()}`;

      const push: LinkingPushMessage = {
        type: "tokens_issued",
        channelId: target.channelId,
        sessionId: randomUUID(),
        accessToken: target.accessToken,
        refreshToken: target.refreshToken,
        issuedAt: Date.now()
      };

      emit(target, push);

      socket.send(JSON.stringify({ type: "linked", ok: true }));
      socket.close();
    } catch {
      socket.close(1008, "Invalid message");
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Sealine linking mock server listening on 0.0.0.0:${PORT}`);
});
