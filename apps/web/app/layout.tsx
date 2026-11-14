import type { Metadata } from "next";
import type { JSX, ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sealine Web",
  description:
    "Sealine on the web — link this browser from your phone and message from your desk. End-to-end encrypted.",
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Type system, shared with the mobile app: Space Grotesk carries
            headings and the wordmark, Inter carries all body and UI text, and
            IBM Plex Mono is reserved for protocol strings — wpt:// links,
            countdowns, timestamps, version stamps. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
