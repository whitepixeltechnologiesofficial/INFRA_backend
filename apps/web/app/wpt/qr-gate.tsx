"use client";

// WEB-R1.1–R1.3 QR linking gate. Only one live QR exists server-side; a fresh
// token is minted on expiry or when the currently displayed code is replaced.
// A dedicated qrSession socket hears accountLinked (the phone confirmed) and
// qrExpired, and the visible countdown mirrors the server TTL.

import React, { useEffect, useRef, useState, type JSX } from "react";
import { wptApi } from "../lib/api";
import { openWptSocket, wptEventFromMessage } from "../lib/ws";

export interface QrGateProps {
  notice: string | null;
  onLinked: (webToken: string, userId: string) => void;
}

interface QrSnapshot {
  token: string;
  linkUrl: string;
  qrDataUrl: string;
  expiresAt: number;
}

interface QrNewResponse {
  ok: boolean;
  token: string;
  linkUrl: string;
  qrDataUrl: string;
  expiresAt: number;
}

export function QrGate({ notice, onLinked }: QrGateProps): JSX.Element {
  const [qr, setQr] = useState<QrSnapshot | null>(null);
  const [remaining, setRemaining] = useState(0);
  const qrRef = useRef<QrSnapshot | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mintingRef = useRef(false);
  const onLinkedRef = useRef(onLinked);
  onLinkedRef.current = onLinked;

  function closeQrSocket(): void {
    if (!wsRef.current) return;
    wsRef.current.onopen = null;
    wsRef.current.onmessage = null;
    wsRef.current.onclose = null;
    try {
      wsRef.current.close();
    } catch {
      /* already closed */
    }
    wsRef.current = null;
  }

  function connectQrSocket(token: string): void {
    closeQrSocket();
    const ws = openWptSocket({ qrSession: token });
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      const e = wptEventFromMessage(ev.data);
      if (!e) return;
      if (e.type === "accountLinked") {
        closeQrSocket();
        const webToken = typeof e.webToken === "string" ? e.webToken : "";
        const userId = typeof e.userId === "string" ? e.userId : "";
        if (webToken) onLinkedRef.current(webToken, userId);
        else void mintQr();
      } else if (e.type === "qrExpired") {
        void mintQr();
      }
    };
  }

  async function mintQr(): Promise<void> {
    if (mintingRef.current) return;
    mintingRef.current = true;
    try {
      const r = await wptApi<QrNewResponse>("GET", "/api/link/new");
      if (!r.ok || !r.body) return;
      const snap: QrSnapshot = { token: r.body.token, linkUrl: r.body.linkUrl, qrDataUrl: r.body.qrDataUrl, expiresAt: r.body.expiresAt };
      qrRef.current = snap;
      setQr(snap);
      setRemaining(Math.max(0, Math.ceil((snap.expiresAt - Date.now()) / 1000)));
      connectQrSocket(snap.token);
    } finally {
      mintingRef.current = false;
    }
  }

  useEffect(() => {
    void mintQr();
    const iv = window.setInterval(() => {
      const current = qrRef.current;
      if (!current) return;
      const secs = Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000));
      setRemaining(secs);
      if (secs === 0) void mintQr();
    }, 500);
    return () => {
      window.clearInterval(iv);
      closeQrSocket();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="brand">
          <div className="logo">S</div>
          <b>WPT Chat</b>
        </div>
        {notice ? (
          <div className="force-note" role="alert">
            <div className="force-note-title">Your session ended</div>
            <p>
              A new phone signed in to this account, so this Web session was closed immediately. Scan the QR below to
              reconnect.
            </p>
          </div>
        ) : (
          <h1 className="gate-title">Scan to open WPT Chat</h1>
        )}
        <p className="muted">Open the camera on your phone and point it at this code to link this computer.</p>
        {qr ? (
          <>
            <div className="qr-wrap">
              <img className="qr-img" src={qr.qrDataUrl} alt="WPT login QR code" width={220} height={220} />
              <div className="qr-meta">
                <span className={`qr-pill ${remaining <= 10 ? "qr-pill-expiring" : ""}`}>Refreshes in {remaining}s</span>
                <a className="qr-link" href={qr.linkUrl} target="_blank" rel="noreferrer">
                  Scan trouble? Open the link
                </a>
              </div>
            </div>
          </>
        ) : (
          <div className="qr-placeholder">
            <span className="spinner" />
            <p className="muted">Preparing a fresh code…</p>
          </div>
        )}
        <div className="gate-foot">
          Session is stored on this device and survives closing this tab. Sign out with Settings → Logout.
        </div>
      </div>
    </div>
  );
}