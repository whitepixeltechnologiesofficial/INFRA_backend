// Client bridge to the shared message-composition logic. All kind/limit rules
// come from @wpt/shared (single source of truth); this module only adapts them
// for the Web client (attachment URL builder) and re-exports the shared pieces
// the UI needs. @wpt/shared is consumed as TS source (see next.config.js).

import {
  MAX_TEXT_LENGTH,
  MESSAGE_KINDS,
  MIN_VOICE_SECONDS,
  attachmentMimeOk,
  formatBytes,
  isMessageKind,
  isUsableVoiceSeconds,
  maxAttachmentBytes,
  mediaPreviewText,
  validateAttachment,
  type AttachmentValidation,
  type MessageKind,
} from "@wpt/shared";
import { wptApiBase } from "./api";

export type { AttachmentValidation, MessageKind } from "@wpt/shared";
export { MAX_TEXT_LENGTH, MESSAGE_KINDS, MIN_VOICE_SECONDS, attachmentMimeOk, formatBytes, isMessageKind, isUsableVoiceSeconds, maxAttachmentBytes, mediaPreviewText, validateAttachment };

export const MAX_ATTACHMENT_BYTES = maxAttachmentBytes();

export interface ClientMediaAttachment {
  kind: "image" | "voice";
  dataUrl: string;
  mimeType: string;
  sizeBytes: number;
  durationSec?: number;
}

export function attachmentLimitLabel(): string {
  return formatBytes(MAX_ATTACHMENT_BYTES);
}

export function mediaUrl(attachmentId: string | number | null | undefined): string {
  return attachmentId == null || String(attachmentId) === "" ? "" : `${wptApiBase()}/api/media/${encodeURIComponent(String(attachmentId))}`;
}