// WEB-2.5 — Manual number entry, NO invite option.
//
// Entering an unregistered phone number in New Chat shows a "not registered"
// message — and nothing else. There is deliberately NO invite/share mechanism
// on Web (locked Section-5 design; mobile-only feature, intentionally excluded).
//
// Contract (the edge case the card calls out): number-format validation runs
// BEFORE the registration check. A malformed number must get a format error,
// never a false "not registered". The server enforces the same ordering.
// This module is self-contained and erasable-only so Node harnesses import it
// directly with type stripping.

// Minimal E.164 full-form normalizer (Web needs the country code: there is no
// trusted device country on a linked browser, so national formats are a format
// error, not a guessed number). Returns "+<digits>" or null when malformed.
export function normalizeToE164(raw: string): string | null {
  const cleaned = String(raw ?? "").trim().replace(/[\s().-]+/g, "");
  if (!/^\+[0-9]+$/.test(cleaned)) return null;
  const digits = cleaned.slice(1);
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits[0] === "0") return null;
  return "+" + digits;
}

export const MANUAL_NUMBER_ROUTE = "/api/contacts/check";

export const MANUAL_NUMBER_LABEL = "Start a new chat by number";
export const MANUAL_NUMBER_PLACEHOLDER = "e.g. +91 98765 43210";
export const MANUAL_NUMBER_CHECK_ACTION = "Check";

export const NUMBER_FORMAT_ERROR_COPY =
  "That doesn't look like a phone number — include the country code, e.g. +91 98765 43210.";

export const NUMBER_NOT_REGISTERED_COPY =
  "This number isn't registered on Sealine yet. There's nothing to send — try again once they've joined.";

export const NUMBER_CHECK_UNAVAILABLE_COPY = "Couldn't check that number — try again in a moment.";

export interface ManualNumberCheckUser {
  id: string;
  name: string;
  role?: string;
}

export interface ManualNumberCheckResponse {
  ok: boolean;
  registered?: boolean;
  user?: ManualNumberCheckUser;
  error?: string;
}

// Shape guard so the client only consumes a well-formed relay answer.
export function isManualNumberCheckResponse(value: unknown): value is ManualNumberCheckResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as ManualNumberCheckResponse;
  return (
    v.ok === true &&
    typeof v.registered === "boolean" &&
    (v.registered === false || (!!v.user && typeof v.user.id === "string" && typeof v.user.name === "string"))
  );
}