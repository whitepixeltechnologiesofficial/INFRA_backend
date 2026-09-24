"use client";

import type { JSX } from "react";
import { Seal } from "./seal";

export function LinkingScreen(): JSX.Element {
  return (
    <div className="linking">
      <Seal />
      <h1 className="linking-title">Linking your device…</h1>
      <p className="linking-sub">Generating a fresh encryption identity for this browser</p>
      <div className="loading-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <p className="linking-note">You can keep using Web while this browser reloads.</p>
    </div>
  );
}