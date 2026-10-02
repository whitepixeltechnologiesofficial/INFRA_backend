"use client";

// QR linking gate (WEB-R1.1–R1.3, WEB-R1.8 end-state). One live QR is served at
// a time and it is produced by the BROWSER, in this order:
//
//   generate (crypto.getRandomValues) → register (POST /api/link/register) →
//   render (npm qrcode) → listen (one live link channel) → redeem (pushed code).
//
// There is no mint call and no "am I linked yet?" poll. The backend pushes the
// login hand-off onto the link channel the moment the phone approves, and this
// component spends that single-use code at POST /api/link/redeem, which is where
// the HttpOnly session cookie is set. The visible countdown mirrors the
// backend's authoritative TTL; on expiry a whole new token is generated,
// registered and shown.
//
// The screen has one job beyond the protocol: make the direction of trust
// unmistakable. The phone authorizes the browser. Nothing here can be approved
// from the keyboard, and the browser never learns a credential it could leak.
// Six states are designed: preparing, waiting, expired, approved (see
// LinkingScreen), revoked (force-logout notice) and failed.
//
// DEVELOPMENT ONLY: a second, clearly subordinate code appears below the real
// one in a dev build. The production QR carries `wpt://link/<token>`, which only
// the Sealine app can open, so exercising the funnel during development would
// otherwise need a physical phone in front of the screen every time. The dev
// code encodes a plain `http://<lan-host>:<port>/dev/test-login?phone=…` URL
// that ANY QR scanner opens, and the dev route runs the same real protocol. It
// is additive: the real code is never replaced, and this block compiles out of a
// production build entirely. See app/lib/dev-test-login.ts for the contract and
// app/dev/test-login/route.ts for the (server-side, dev-only) route.

import React, { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import { Seal } from "./seal";
import { Icon } from "./icons";
import { webLinkQrDataUrl } from "../lib/web-link-qr";
import {
  buildDevTestLoginUrl,
  devQrUnavailableReason,
  devTestPhoneList,
  resolveDevQrOrigin,
} from "../lib/dev-test-login";
import {
  openLinkChannel,
  redeemWebLink,
  registerWebLink,
  type LinkChannel,
  type WebLinkRegistered,
} from "../lib/web-link-client";
import { webLinkQrPayload } from "@wpt/shared";

export interface QrGateProps {
  notice: string | null;
  flash: string | null;
  onLinked: (claimed: { userId: string; accountName: string }) => void;
  onFlashClear: () => void;
}

interface QrSnapshot {
  linkId: string;
  qrDataUrl: string;
  expiresAt: number;
  totalSecs: number;
}

/** Compiled out of a production build, so the block below is unreachable there. */
const DEV_QR_ENABLED = process.env.NODE_ENV !== "production";

/**
 * The development-only "open it with anything" code.
 *
 * Rendered beside the real QR, never instead of it. It is deliberately plain: a
 * developer affordance in the product's own tokens, not a second design, and it
 * carries no credential — only the address and the allowlisted test phone.
 */
function DevTestLoginCode(): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    // The configured LAN origin wins, because the phone — not this browser — is
    // what has to resolve it. Falling back to the page's own origin means a
    // developer who opened the page by its LAN address needs no configuration at
    // all, and no address is ever hard-coded in the repository.
    const resolved = resolveDevQrOrigin(process.env.NEXT_PUBLIC_DEV_QR_ORIGIN, window.location.origin);
    const phone = devTestPhoneList()[0];
    const built = buildDevTestLoginUrl(resolved.origin, phone);
    if (!built) {
      setDataUrl(null);
      setUrl(null);
      setReason(devQrUnavailableReason(resolved));
      return;
    }
    setReason(null);
    setUrl(built);
    let cancelled = false;
    void webLinkQrDataUrl(built)
      .then((png) => {
        if (cancelled) return;
        setDataUrl(png);
      })
      .catch(() => {
        if (cancelled) return;
        setDataUrl(null);
        setReason("We couldn't draw a test code. Please try again.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="qr-dev">
      <div className="qr-dev-head">
        <span className="qr-dev-tag">Dev only</span>
        <span className="qr-dev-title">Open with any QR scanner</span>
      </div>
      {dataUrl && url ? (
        <>
          <img className="qr-dev-img" src={dataUrl} alt={`Development test login QR for ${url}`} />
          <p className="qr-dev-note">
            For local testing only. Scanning this with a normal phone camera opens a dev-only route that signs in the
            real backend account for the allowlisted test phone. It does not work in production, and the code above is
            the real one.
          </p>
          <code className="qr-dev-url">{url}</code>
        </>
      ) : (
        <p className="qr-dev-note">{reason ?? "Preparing the test code…"}</p>
      )}
    </div>
  );
}

export function QrGate({ notice, flash, onLinked, onFlashClear }: QrGateProps): JSX.Element {
  const [qr, setQr] = useState<QrSnapshot | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastOn, setToastOn] = useState(false);
  const qrRef = useRef<QrSnapshot | null>(null);
  const channelRef = useRef<LinkChannel | null>(null);
  const startingRef = useRef(false);
  const cycleRef = useRef(0);
  const mountedRef = useRef(true);
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

  /**
   * One full cycle: browser-generated token → backend registration → QR pixels →
   * live link channel. Nothing is rendered and nothing is shown before the
   * registration resolves ok:true.
   */
  const startCycle = useCallback(async (): Promise<void> => {
    if (startingRef.current) return;
    startingRef.current = true;
    setBusy(true);
    setError(null);
    // Retire the previous channel before minting a new token, so a late push can
    // never complete a code the user is no longer looking at.
    channelRef.current?.close();
    channelRef.current = null;
    qrRef.current = null;
    setQr(null);
    const cycle = ++cycleRef.current;
    // Anything this cycle has already started is dead the moment a newer cycle
    // begins: a stale channel must neither be installed, listened to, nor used
    // to close a live one.
    const stale = () => cycleRef.current !== cycle || !mountedRef.current;

    const registered = await registerWebLink();
    if (stale()) {
      startingRef.current = false;
      return;
    }
    if (!registered.ok) {
      startingRef.current = false;
      setBusy(false);
      setError(registered.message);
      return;
    }
    const live = registered as WebLinkRegistered;

    let qrDataUrl: string;
    try {
      qrDataUrl = await webLinkQrDataUrl(webLinkQrPayload(live.token));
    } catch {
      startingRef.current = false;
      if (stale()) return;
      setBusy(false);
      setError("We couldn't draw a login code. Please try again.");
      return;
    }
    const totalSecs = Math.max(1, Math.ceil((live.expiresAt - Date.now()) / 1000));
    const snap: QrSnapshot = { linkId: live.linkId, qrDataUrl, expiresAt: live.expiresAt, totalSecs };
    qrRef.current = snap;
    setQr(snap);
    setRemaining(totalSecs);
    setExpired(false);
    setBusy(false);
    startingRef.current = false;

    let channel: LinkChannel;
    try {
      channel = await openLinkChannel(live.realtimeBaseUrl, live.linkTicket, {
        onLogin: (push) => {
          if (stale()) return;
          void (async () => {
            const res = await redeemWebLink(push.code);
            if (stale()) return;
            if (res.ok) {
              channelRef.current?.close();
              channelRef.current = null;
              onLinkedRef.current({ userId: res.userId, accountName: res.accountName });
              return;
            }
            // The code is single-use: whether it was spent elsewhere, aged out,
            // or the network dropped mid-exchange, this QR can no longer complete.
            // A fresh token is the only correct response — never a re-poll.
            void startCycle();
          })();
        },
        onChannelLost: () => {
          if (stale()) return;
          // The link ticket (60s) or the link itself is spent. Either way this QR
          // can no longer complete, so retire it and start over with a new token.
          void startCycle();
        },
      });
    } catch {
      // The channel never came up (bad origin, offline, refused). Leave nothing
      // half-open and start over rather than showing a QR that cannot complete.
      if (stale()) return;
      void startCycle();
      return;
    }
    // A newer cycle may have started while this channel was being dialled. Install
    // this connection only if it is still the live one, and close it immediately
    // otherwise — never overwrite the live channel, never leak this one.
    if (stale()) {
      channel.close();
      return;
    }
    channelRef.current = channel;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void startCycle();
    const iv = window.setInterval(() => {
      const current = qrRef.current;
      if (!current) return;
      const secs = Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000));
      setRemaining(secs);
      if (secs === 0) {
        setExpired(true);
        void startCycle();
      }
    }, 500);
    return () => {
      mountedRef.current = false;
      // Retire this cycle so an in-flight registration/channel can neither
      // install itself nor react after the gate is gone.
      cycleRef.current += 1;
      window.clearInterval(iv);
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, [startCycle]);

  const pct = qr ? Math.max(0, Math.min(1, remaining / qr.totalSecs)) : 0;
  const clockStyle = { "--pct": String(pct) } as CSSProperties;
  const expiring = remaining > 0 && remaining <= 10;

  return (
    <div className="qr-screen">
      {/* Explanatory column: who authorizes what, and how. */}
      <div className="gate-side">
        <div className="gate-side-brand">
          <Seal />
          <div>
            <div className="wordmark">Sealine Web</div>
            <div className="wordmark-sub">Linked from your phone</div>
          </div>
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
          <>
            <div className="gate-kicker">Secure linking</div>
            <h1 className="gate-title">Your phone approves this browser</h1>
          </>
        )}

        <p className="gate-lead">
          Sealine Web has no password to type and no account to sign in to. <b>Your phone is the only thing that can
          approve a new browser</b> — it checks the code, then decides.
        </p>

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
        <div className="gate-foot">
          The session is stored in this browser and survives closing this tab. Sealine never sees it, and neither does
          anyone else.
        </div>
      </div>

      {/* The code itself. */}
      <div className="gate-code" role="main">
        <div className="gate-code-head">
          <div className="gate-code-title">Scan to link this browser</div>
          <div className="gate-code-sub">{error ? "We could not prepare a code" : "Waiting for approval on your phone"}</div>
        </div>

        {qr ? (
          <>
            <div className="qr-ring">
              <div className="qr-ring-inner">
                <img className="qr-img" src={qr.qrDataUrl} alt="Sealine login QR code" />
                {expired ? (
                  <div className="qr-exp-overlay">
                    <div className="qr-exp-title">Code expired</div>
                    <div className="qr-exp-sub">Generating a new one…</div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="qr-clock" style={clockStyle}>
              <div className={expiring ? "qr-clock-fill is-expiring" : "qr-clock-fill"} />
            </div>
            <div className="qr-meta">
              <span className={`qr-pill ${expiring ? "qr-pill-expiring" : ""}`}>Refreshes in {remaining}s</span>
              <span className="qr-link" role="note">
                Scan with the Sealine app camera
              </span>
            </div>
          </>
        ) : error ? (
          <div className="qr-placeholder" role="alert">
            <Icon name="warning" size={22} />
            <p>{error}</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void startCycle()} disabled={busy}>
              {busy ? "Retrying…" : "Try again"}
            </button>
          </div>
        ) : (
          <div className="qr-placeholder">
            <div className="loading-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <p>Generating a secure code…</p>
          </div>
        )}

        <div className="gate-foot-col">
          A fresh code is made automatically when the old one runs out, and each code works exactly once.
        </div>
        {DEV_QR_ENABLED ? <DevTestLoginCode /> : null}
      </div>

      <div className="qr-footer">
        <a href="#">Terms</a>
        <a href="#">Privacy</a>
        <a href="#">Help</a>
      </div>

      <div className={`toast ${toastOn ? "show" : ""}`} role="status">
        <span className="toast-check">
          <Icon name="check" size={15} />
        </span>
        <span>{flash}</span>
      </div>
    </div>
  );
}
