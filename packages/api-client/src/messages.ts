// Relay-send surface for Web messages (text / image / voice).
//
// Transport-neutral helpers for the WPT web server's real-time relay: a body
// builder plus a plain-fetch sender. Types mirror @wpt/shared's MessageKind —
// the canonical composition/limits live in @wpt/shared (see messages.ts).
// Deliberately self-contained (no socket.io, no /api/v1 coupling) so it works
// against any implementation of the relay contract (the WPT web server today,
// the backend BE-5.4 relay tomorrow).

export type RelayMessageKind = "text" | "image" | "voice";

export interface RelaySendInput {
  from: string;
  type: "direct" | "group";
  to?: string;
  groupId?: string;
  kind?: RelayMessageKind;
  text?: string;
  dataUrl?: string;
  mimeType?: string;
  sizeBytes?: number;
  durationSec?: number;
}

export interface RelayMessageBody {
  from: string;
  type: "direct" | "group";
  kind: RelayMessageKind;
  text: string;
  to?: string;
  groupId?: string;
  dataUrl?: string;
  mimeType?: string;
  sizeBytes?: number;
  durationSec?: number;
}

export interface RelaySentMessage {
  id: string | number;
  from: string;
  text: string;
  time: string;
  mKind?: string;
  attachmentId?: string | number;
  mimeType?: string;
  sizeBytes?: number;
  durationSec?: number;
}

export interface SendRelayResult {
  status: number;
  ok: boolean;
  body: { ok: boolean; message?: RelaySentMessage } | null;
}

export function buildRelaySendBody(input: RelaySendInput): RelayMessageBody {
  const kind: RelayMessageKind = input.kind === "image" || input.kind === "voice" ? input.kind : "text";
  const body: RelayMessageBody = {
    from: input.from,
    type: input.type,
    kind,
    text: kind === "text" ? String(input.text ?? "") : "",
    to: input.to,
    groupId: input.groupId,
  };
  if (kind !== "text") {
    body.dataUrl = input.dataUrl;
    body.mimeType = input.mimeType;
    body.sizeBytes = input.sizeBytes;
    if (kind === "voice") body.durationSec = input.durationSec;
  }
  return body;
}

export async function sendRelayMessage(baseUrl: string, body: RelayMessageBody): Promise<SendRelayResult> {
  const base = baseUrl ? String(baseUrl).replace(/\/+$/, "") : "";
  let res: Response;
  try {
    res = await fetch(`${base}/api/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { status: 0, ok: false, body: { ok: false } };
  }
  let parsed: { ok: boolean; message?: RelaySentMessage } | null = null;
  try {
    const json: unknown = await res.json();
    if (json && typeof json === "object") parsed = json as { ok: boolean; message?: RelaySentMessage };
  } catch {
    parsed = null;
  }
  return { status: res.status, ok: res.ok, body: parsed };
}