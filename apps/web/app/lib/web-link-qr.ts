// Client-side QR rendering for the linking code (R1.7).
//
// Visual rendering ONLY, via the maintained npm `qrcode` package. The token is
// generated and registered by the BROWSER (see web-link-client.ts) — this
// module never mints, derives or stores a token; it only encodes the URI it is
// handed, and it is only ever called AFTER registration succeeded.
//
// Rendering here rather than on the server is deliberate: the QR is the last
// step of "generate → register → show", so the pixels cannot exist before the
// backend has admitted the token they encode.

import QRCode from "qrcode";

export function webLinkQrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: "H",
    margin: 4,
    scale: 8,
    color: { dark: "#0b0f14", light: "#ffffff" },
  });
}
