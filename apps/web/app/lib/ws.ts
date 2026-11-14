// Real-time surface for the Web client: a JSON message protocol over the
// standard WebSocket API (the WPT web server implements the same events with
// node:http + `ws`; no Socket.io is involved on either side anymore).
export interface WptEvent {
  type: string;
  [key: string]: unknown;
}

export function wptSocketUrl(params: Record<string, string>): string {
  const apiBase = process.env.NEXT_PUBLIC_WPT_API_URL;
  let base: string;
  if (apiBase && apiBase.trim()) {
    base = apiBase.replace(/\/+$/, "");
  } else if (typeof window !== "undefined") {
    base = window.location.protocol === "https:" ? "wss://" : "ws://";
    base += window.location.host;
  } else {
    base = "ws://localhost";
  }
  base = base.replace(/^https?:/, (m) => (m === "https:" ? "wss:" : "ws:"));
  const qs = new URLSearchParams(params);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${qs.toString()}`;
}

export function openWptSocket(params: Record<string, string>): WebSocket {
  return new WebSocket(wptSocketUrl(params));
}

export function wptEventFromMessage(data: unknown): WptEvent | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") return null;
    const e = parsed as WptEvent;
    return typeof e.type === "string" ? e : null;
  } catch {
    return null;
  }
}