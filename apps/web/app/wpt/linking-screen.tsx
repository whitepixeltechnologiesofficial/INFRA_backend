"use client";

// The approved state. The phone has just accepted the code; the browser is
// spending the single-use hand-off and building its own encryption identity.
// Short-lived by design — this is a confirmation, not a place to linger.

import type { JSX } from "react";
import { Seal } from "./seal";
import { Icon } from "./icons";

export function LinkingScreen(): JSX.Element {
  return (
    <div className="linking" role="status" aria-live="polite">
      <div className="linking-inner">
        <div className="linking-mark">
          <Seal />
        </div>
        <h1 className="linking-title">Phone approved</h1>
        <p className="linking-sub">Linking your device…</p>

        <div className="linking-steps">
          <div className="linking-step">
            <Icon name="checkCircle" size={18} />
            Code accepted on your phone
          </div>
          <div className="linking-step">
            <Icon name="checkCircle" size={18} />
            Generating a fresh encryption identity for this browser
          </div>
          <div className="linking-step is-pending">
            <Icon name="chatbubbles" size={18} />
            Loading your chats
          </div>
        </div>
      </div>
    </div>
  );
}
