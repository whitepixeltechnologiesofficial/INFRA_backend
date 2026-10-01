"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { generateLinkingToken, generateWebPublicKeys } from "@wpt/crypto";
import { LINKING_TOKEN_TTL_SECONDS, type AccountLinkedPayload, type RegisterLinkingRequest } from "@wpt/shared";
import { useSession } from "../app/providers";
import { useSearchParams } from "next/navigation";
import type { Socket } from "socket.io-client";

export function LinkingScreen() {
  const { backend, linked, saveLinkedSession } = useSession();
  const searchParams = useSearchParams();
  const [token, setToken] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [status, setStatus] = useState("Creating secure linking QR…");
  const [showLogoutPopup, setShowLogoutPopup] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const linkedRef = useRef(false);
  const reconnectTimer = useRef<number | null>(null);
  const registeredAt = useRef(0);

  useEffect(() => {
    const reason = searchParams.get("reason");
    if (reason) {
      setShowLogoutPopup(true);
    }
  }, [searchParams]);

  const createQr = useCallback((reuseToken?: string) => {
    if (!backend) {
      setStatus("Set NEXT_PUBLIC_API_BASE_URL to the real BE-6.1 backend.");
      return;
    }
    socketRef.current?.close();
    const newToken = reuseToken ?? backend.createToken();
    const keys = generateWebPublicKeys();
    registeredAt.current = Date.now();
    linkedRef.current = false;
    setToken(newToken);
    setStatus("Waiting for your phone to scan…");

    const request: RegisterLinkingRequest = {
      token: newToken,
      ttlSeconds: 60,
      identityBundle: {
        version: 1,
        identityId: `web-${Date.now()}`,
        algorithm: "ECDH-P256",
        publicKeyJwk: {
          kty: "EC",
          crv: "P-256",
          x: keys.identityPublicKey,
          y: keys.signingPublicKey
        }
      }
    };

    const registration = backend.register(request);
    socketRef.current = registration.socket;

    registration.socket.on("accountLinked", (payload: AccountLinkedPayload) => {
      linkedRef.current = true;
      setStatus("Linked. Opening Sealine…");
      saveLinkedSession(payload);
    });

    registration.socket.on("linkExpired", () => {
      if (linkedRef.current) return;
      registration.close();
      createQr();
    });

    registration.socket.on("connect_error", (error: Error) => {
      if (linkedRef.current) return;
      setStatus(`Backend connection error: ${error.message}`);
    });

    registration.socket.on("disconnect", () => {
      if (linkedRef.current) return;
      const age = Date.now() - registeredAt.current;
      if (age < LINKING_TOKEN_TTL_SECONDS * 1000) {
        if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = window.setTimeout(() => createQr(newToken), 500);
      }
    });
  }, [backend, saveLinkedSession]);

  useEffect(() => {
    createQr();
    return () => {
      socketRef.current?.close();
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
    };
  }, [createQr]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((registeredAt.current + LINKING_TOKEN_TTL_SECONDS * 1000 - Date.now()) / 1000));
      setExpiresAt(registeredAt.current + LINKING_TOKEN_TTL_SECONDS * 1000);
      setSecondsLeft(remaining);
      if (remaining === 0 && token && !linkedRef.current) createQr();
    }, 500);
    return () => window.clearInterval(timer);
  }, [createQr, token]);

  if (linked) return <main className="page"><section className="card success"><div style={{ fontSize: 56 }}>👋</div><h1>Welcome to Sealine</h1><p className="muted">Your account has been linked successfully.</p></section></main>;

  return <main className="page">
    <section className="card">
      <div className="brand">Sealine</div>
      <p className="muted">Open Sealine on your phone → Settings → Linked Devices → Link a Device.</p>
      {token && <>
        <div className="qr"><QRCodeSVG value={token} size={280} level="M" /></div>
        <div className="countdown">QR expires in {secondsLeft}s</div>
      </>}
      <div className="status">{status}</div>
      {expiresAt > 0 && <button className="primary" onClick={() => createQr()}>Refresh QR</button>}
    </section>
    {showLogoutPopup && (
      <div className="popup-overlay" onClick={() => setShowLogoutPopup(false)}>
        <div className="popup" onClick={(e) => e.stopPropagation()}>
          <h2>Session Ended</h2>
          <p>You are logged out or session expired</p>
          <button className="primary" onClick={() => setShowLogoutPopup(false)}>OK</button>
        </div>
      </div>
    )}
  </main>;
}