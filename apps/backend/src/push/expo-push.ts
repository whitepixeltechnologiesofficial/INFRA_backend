/**
 * PERM-2.5 — Expo push delivery.
 *
 * Messages are end-to-end encrypted, so a push carries NO message content:
 * only a generic "New message" alert. Expo's push service forwards it to
 * FCM (Android) or APNs (iOS) for the device's token.
 *
 * Delivery is best-effort and never throws: a failed push must not fail
 * the relay send that triggered it. Set PUSH_DISABLED=1 to turn it off.
 */

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

const EXPO_TOKEN_RE = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/;

export function isExpoPushToken(token: unknown): token is string {
  return typeof token === "string" && token.length <= 256 && EXPO_TOKEN_RE.test(token);
}

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  sound: "default";
  channelId: string;
  priority: "high";
  data: Record<string, string>;
}

export function buildMessageAlert(token: string): PushMessage {
  return {
    to: token,
    title: "New message",
    body: "You have a new message",
    sound: "default",
    channelId: "messages",
    priority: "high",
    data: { type: "message" },
  };
}

export type PushFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

let fetchImpl: PushFetch | null = null;

/** Test seam: route pushes to a fake transport instead of the network. */
export function overridePushFetch(f: PushFetch | null): void {
  fetchImpl = f;
}

export function pushEnabled(): boolean {
  return process.env.PUSH_DISABLED !== "1";
}

export async function sendExpoPush(tokens: string[]): Promise<{ sent: number; ok: boolean }> {
  const valid = tokens.filter(isExpoPushToken);
  if (valid.length === 0 || !pushEnabled()) return { sent: 0, ok: true };
  const f: PushFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const res = await f(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(valid.map(buildMessageAlert)),
    });
    return { sent: valid.length, ok: res.ok };
  } catch {
    console.error("expo push send failed");
    return { sent: 0, ok: false };
  }
}
