// Message-send parity — the canonical composition + limits for Web messages.
// Single source of truth for the kinds a message can carry and the size rules
// an attachment must satisfy. The Web client uses this directly; the WPT web
// server pins the same constants (the verify suite asserts they can't drift);
// the mobile app will adopt this module when it wires the shared cap.
//
// NOTE: this module is deliberately self-contained and uses only erasable
// TypeScript syntax (no enums, no runtime type syntax) so Node's native type
// stripping can import it directly in verification harnesses.

export type MessageKind = "text" | "image" | "voice";

export const MESSAGE_KINDS: readonly MessageKind[] = ["text", "image", "voice"];

// Shared attachment cap: one limit for every media kind (image + voice).
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MiB

// Voice parity with the mobile rule: a usable voice note is at least 1s.
export const MIN_VOICE_SECONDS = 1;

export const MAX_TEXT_LENGTH = 4000;

export const IMAGE_MIME_PREFIX = "image/";
export const VOICE_MIME_PREFIX = "audio/";

export function isMessageKind(value: unknown): value is MessageKind {
  return value === "text" || value === "image" || value === "voice";
}

export function maxAttachmentBytes(): number {
  return MAX_ATTACHMENT_BYTES;
}

export function minVoiceSeconds(): number {
  return MIN_VOICE_SECONDS;
}

export function isUsableVoiceSeconds(sec: number | null | undefined): sec is number {
  return typeof sec === "number" && Number.isFinite(sec) && sec >= MIN_VOICE_SECONDS;
}

export function attachmentMimeOk(kind: MessageKind, mimeType: string): boolean {
  if (kind === "image") return mimeType.startsWith(IMAGE_MIME_PREFIX);
  if (kind === "voice") return mimeType.startsWith(VOICE_MIME_PREFIX);
  return false;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const label = value >= 100 ? Math.round(value).toString() : String(Math.round(value * 10) / 10);
  return `${label} ${units[unit] ?? "KB"}`;
}

export const ATTACHMENT_LIMIT_LABEL: string = formatBytes(MAX_ATTACHMENT_BYTES);

export const OVER_LIMIT_ERROR: string = `Attachment is too large — Sealine accepts up to ${ATTACHMENT_LIMIT_LABEL}.`;

export const VOICE_TOO_SHORT_ERROR: string = `Voice message is too short — record for at least ${MIN_VOICE_SECONDS} second.`;

export const BAD_IMAGE_MIME_ERROR = "Unsupported file type for image attachments.";

export const BAD_VOICE_MIME_ERROR = "Unsupported file type for voice attachments.";

export interface AttachmentInput {
  kind: MessageKind;
  sizeBytes: number;
  mimeType?: string | null;
  durationSec?: number | null;
}

export type AttachmentValidation =
  | { ok: true }
  | {
      ok: false;
      code: "missing_payload" | "bad_size" | "attachment_too_large" | "voice_too_short" | "bad_mime";
      error: string;
    };

export function validateAttachment(input: AttachmentInput): AttachmentValidation {
  if (input.kind !== "image" && input.kind !== "voice") return { ok: true };
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 0) {
    return { ok: false, code: "bad_size", error: "Attachment size is invalid." };
  }
  if (input.sizeBytes > MAX_ATTACHMENT_BYTES) {
    return { ok: false, code: "attachment_too_large", error: OVER_LIMIT_ERROR };
  }
  if (input.kind === "voice" && !isUsableVoiceSeconds(input.durationSec)) {
    return { ok: false, code: "voice_too_short", error: VOICE_TOO_SHORT_ERROR };
  }
  if (input.mimeType && !attachmentMimeOk(input.kind, input.mimeType)) {
    return {
      ok: false,
      code: "bad_mime",
      error: input.kind === "image" ? BAD_IMAGE_MIME_ERROR : BAD_VOICE_MIME_ERROR,
    };
  }
  return { ok: true };
}

export function mediaPreviewText(kind: MessageKind): string {
  if (kind === "image") return "Image";
  if (kind === "voice") return "Voice message";
  return kind;
}