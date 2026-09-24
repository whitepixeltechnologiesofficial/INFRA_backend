import type { JSX } from "react";

export function Seal(): JSX.Element {
  return (
    <div className="seal" role="img" aria-label="Sealine">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M3 10.5c2.5 0 2.5-1.9 5-1.9s2.5 1.9 5 1.9 2.5-1.9 5-1.9 2.5 1.9 5 1.9" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
        <path d="M3 15.5c2.5 0 2.5-1.9 5-1.9s2.5 1.9 5 1.9 2.5-1.9 5-1.9 2.5 1.9 5 1.9" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" opacity="0.55" />
      </svg>
    </div>
  );
}