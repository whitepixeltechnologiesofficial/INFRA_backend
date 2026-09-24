"use client";

// QR linking gate (WEB-R1.1–R1.3, WEB-R1.8 end-state). Only one live QR exists
// server-side; a fresh token is minted on expiry or when the displayed code is
// replaced. A dedicated qrSession socket hears accountLinked (the phone
// confirmed) and qrExpired, and the visible countdown mirrors the server TTL.
//
// WEB 2.1: Phase-5 Sealine visual — conic countdown ring around the code,
// expired overlay, linking steps, wordmark. The force-logout notice keeps its
// required copy verbatim (web-e2e asserts it) and a toast surfaces the manual
// "Logged off this browser" flash passed down from the orchestrator.

import React, { useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import { wptApi } from "../lib/api";
import { openWptSocket, wptEventFromMessage } from "../lib/ws";
import { Seal } from "./seal";

export interface QrGateProps {
  notice: string | null;
  flash: string | null;
  onLinked: (webToken: string, userId: string) => void;
  onFlashClear: () => void;
}

interface QrSnapshot {
  token: string;
  linkUrl: string;
  qrDataUrl: string;
  expiresAt: number;
  totalSecs: number;
}

interface QrNewResponse {
  ok: boolean;
  token: string;
  linkUrl: string;
  qrDataUrl: string;
  expiresAt: number;
}

export function QrGate({ notice, flash, onLinked, onFlashClear }: QrGateProps): JSX.Element {
  const [qr, setQr] = useState<QrSnapshot | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [expired, setExpired] = useState(false);
  const [toastOn, setToastOn] = useState(false);
  const qrRef = useRef<QrSnapshot | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mintingRef = useRef(false);
  const onLinkedRef = useRef(onLinked);
  onLinkedRef.current = onLinked;

  useEffect(() => {
    if (!flash) {
      setToastOn(false);
      return;
    }
    setToastOn(true);
    const t = window.setTimeout(() => {
      setToastOn(false);
      onFlashClear();
    }, 2600);
    return () => window.clearTimeout(t);
  }, [flash, onFlashClear]);

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
      const totalSecs = Math.max(1, Math.ceil((r.body.expiresAt - Date.now()) / 1000));
      const snap: QrSnapshot = { token: r.body.token, linkUrl: r.body.linkUrl, qrDataUrl: r.body.qrDataUrl, expiresAt: r.body.expiresAt, totalSecs };
      qrRef.current = snap;
      setQr(snap);
      setRemaining(totalSecs);
      setExpired(false);
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
      if (secs === 0 && !expired) {
        setExpired(true);
        void mintQr();
      }
    }, 500);
    return () => {
      window.clearInterval(iv);
      closeQrSocket();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = qr ? Math.max(0, Math.min(100, (remaining / qr.totalSecs) * 100)) : 0;
  const ringStyle = { "--pct": `${pct}` } as CSSProperties;

  return (
    <div className="qr-screen">
      <div className="seal-block">
        <Seal />
        <div className="wordmark">Sealine Web</div>
        <div className="wordmark-sub">encrypted messaging · session lives in this browser</div>
      </div>

      <div className="qr-card" role="main">
        {notice ? (
          <div className="force-note" role="alert">
            <div className="force-note-title">Your session ended</div>
            <p>
              A new phone signed in to this account, so this Web session was closed immediately. Scan the QR below to
              reconnect.
            </p>
          </div>
        ) : (
          <h1 className="gate-title">Scan to open Sealine</h1>
        )}
        <p className="muted">Open the camera on your phone and point it at this code to link this computer.</p>

        {qr ? (
          <>
            <div className="qr-ring" style={ringStyle}>
              <div className="qr-ring-inner">
                <img className="qr-img" src={qr.qrDataUrl} alt="Sealine login QR code" width={178} height={178} />
                {expired ? (
                  <div className="qr-exp-overlay">
                    <div className="qr-exp-title">Code expired</div>
                    <div className="qr-exp-sub">Generating a new one…</div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="qr-meta">
              <span className={`qr-pill ${remaining <= 10 ? "qr-pill-expiring" : ""}`}>Refreshes in {remaining}s</span>
              <a className="qr-link" href={qr.linkUrl} target="_blank" rel="noreferrer">
                Scan trouble? Open the link
              </a>
            </div>
          </>
        ) : (
          <div className="qr-placeholder">
            <div className="loading-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <p className="muted">Preparing a fresh code…</p>
          </div>
        )}

        <ol className="qr-steps">
          <li>
            <span className="step-no">1</span>
            <span>
              Open the <b>Sealine app</b> on your phone
            </span>
          </li>
          <li>
            <span className="step-no">2</span>
            <span>
              Go to <b>Settings → Linked devices</b>
            </span>
          </li>
          <li>
            <span className="step-no">3</span>
            <span>
              Tap <b>Link a device</b> and scan this code
            </span>
          </li>
        </ol>

        <div className="qr-note">
          <b>Web only works alongside the phone app.</b> If you log off the phone, Web is logged off too. Your chats are
          synced there — this screen is just a view of them.
        </div>
        <div className="gate-foot">Session is stored on this device and survives closing this tab. Sign out with Settings → Log off.</div>
      </div>

      <div className="qr-footer">
        <a href="#">Terms</a>
        <a href="#">Privacy</a>
        <a href="#">Help</a>
      </div>

      <div className={`toast ${toastOn ? "show" : ""}`} role="status">
        <span className="toast-check">✓</span>
        <span>{flash}</span>
      </div>
    </div>
  );
}