// The temporary development QR test-login — ONE contract, three consumers.
//
// This module is deliberately dependency-free, erasable-syntax-only and free of
// any server-only import, because it is read by all three of:
//
//   1. the server route  apps/web/app/dev/test-login/route.ts  (the authority),
//   2. the QR screen     apps/web/app/wpt/qr-gate.tsx         (renders the code),
//   3. the Node harness  apps/web/scripts/web-dev-login-verify.js.
//
// WHY IT EXISTS, and what it is NOT:
//
// The production QR carries `wpt://link/<token>`, which only the Sealine app
// understands. A normal phone camera cannot open it. During development that
// makes the linking funnel awkward to exercise, because it needs a physical
// phone in front of a screen every single time.
//
// So in a DEVELOPMENT build the QR screen additionally offers a second code
// containing a plain `http://<lan-host>:<port>/dev/test-login?phone=…` URL.
// Any QR scanner opens it, the dev route runs the real linking protocol, and
// the browser ends up with the same HttpOnly web session the QR flow produces.
//
// It is NOT a second authentication implementation and it is NOT a second
// production flow:
//
//   * The route is refused outright whenever NODE_ENV === "production" — a
//     server-side gate, not a hidden button (see devTestLoginAllowed).
//   * Only the phones listed in DEV_TEST_PHONES are ever signed in. An
//     unlisted number is refused; there is no default account and no fallback.
//   * WHICH ACCOUNT that phone is comes from the backend, never from here.
//     This module holds phone numbers only — there is no userId and no display
//     name anywhere in it, and the dev route sends only the number. The backend
//     resolves it against its real `users` store (the same phone -> account
//     lookup OTP verify performs) and refuses a number that has no account, so
//     a test login can only ever be issued for an account that exists.
//   * The URL carries a phone number and nothing else. No token, no OTP, no
//     PIN, no key, no session credential, ever.
//   * The session is minted by the backend's real, atomic `redeem`, and lands
//     only in an HttpOnly cookie — the same one the real flow sets. Nothing is
//     written to localStorage and nothing is returned to the page's JavaScript.
//   * /api/link/register, /api/link/redeem, the realtime link ticket, the
//     Socket.IO handshake and mobile authentication are all untouched.
//
// The real `wpt://` QR stays on screen at the same time. This code is additive
// and is never a replacement for it.

/** The route this QR points at. Kept in one place so the QR and the route agree. */
export const DEV_TEST_LOGIN_PATH = "/dev/test-login";

export interface DevTestPhone {
  /** Digits only, i.e. the number as it appears in the QR's `?phone=`. */
  digits: string;
  /**
   * The same number in E.164 form, which is what the backend compares with
   * `users.phone_number` (OTP verify stores exactly this). Declared per entry
   * rather than guessed from the digits, so a number from another country cannot
   * accidentally be sent with the wrong country code.
   */
  e164: string;
  /** How the number is shown on the dev pages. */
  label: string;
}

/**
 * The ONLY phones this flow will log in, keyed by digits-only number.
 *
 * This is a phone allowlist and nothing more: it says which numbers may be
 * used, not who they are. The account each one resolves to is the backend's to
 * determine (see ./account-lookup on the backend).
 *
 * A number that is not listed is refused outright: silently signing in as
 * somebody else is the one failure mode a test-login affordance must not have.
 */
export const DEV_TEST_PHONES: readonly DevTestPhone[] = [
  { digits: "9876543210", e164: "+919876543210", label: "+91 98765 43210" },
];

/** Device id recorded on the dev-created link. Stable, and obviously synthetic. */
export const DEV_TEST_DEVICE_ID = "dev-test-login";

/** Strip formatting so `+91 98765 43210`, `9876543210` and `98 76 54 32 10` agree. */
export function normalizeDevPhone(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

/** Rewrite an international `00<country>…` prefix as `+<country>…`. */
function canonicalInternational(raw: string | null | undefined): string {
  const digits = normalizeDevPhone(raw);
  return digits.startsWith("00") ? `+${digits.slice(2)}` : `+${digits}`;
}

/**
 * Server-side gate. A production build answers 404 and never authenticates.
 *
 * This is the whole of the "development-only" claim on the server: it is not a
 * UI toggle, and the route body reaches no protocol code before it returns.
 */
export function devTestLoginAllowed(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production";
}

/**
 * The allowlisted phone entry for a number, or null. Never guesses, and never
 * returns an identity — there is none to return.
 *
 * Accepted forms are exactly: the digits-only form, and that entry's declared
 * `e164` in `+` or `00` form. Nothing else — in particular no "last 10 digits"
 * fallback, which would make `001199876543210` acceptable.
 */
export function devTestPhone(phone: string | null | undefined): DevTestPhone | null {
  const digits = normalizeDevPhone(phone);
  const direct = DEV_TEST_PHONES.find((entry) => entry.digits === digits);
  if (direct) return direct;
  const wanted = canonicalInternational(phone);
  return DEV_TEST_PHONES.find((entry) => entry.e164 === wanted) ?? null;
}

export function isDevTestPhone(phone: string | null | undefined): boolean {
  return devTestPhone(phone) !== null;
}

/** Every allowlisted phone (digits), for the refusal message and for tests. */
export function devTestPhoneList(): string[] {
  return DEV_TEST_PHONES.map((entry) => entry.digits);
}

/**
 * Hosts a phone cannot use. A phone that scans `http://localhost:3000/...`
 * resolves `localhost` to ITSELF, so such a QR is silently useless at the exact
 * moment somebody needs it. `0.0.0.0` is equally useless as a scan target.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "::") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (/^127\./.test(h)) return true;
  return false;
}

export type DevQrOriginProblem = "unset" | "malformed" | "loopback";

export interface DevQrOrigin {
  /** The origin the QR will address, e.g. `http://192.168.1.10:3000`. */
  origin: string | null;
  /** Set when no usable origin is available; the UI explains it rather than lying. */
  problem: DevQrOriginProblem | null;
}

/**
 * Resolve the origin the dev QR should address.
 *
 * `NEXT_PUBLIC_DEV_QR_ORIGIN` wins, because a developer may well have the page
 * open on `localhost` while the phone can only reach the LAN address — and the
 * phone is the thing that has to resolve it. When it is unset the page's own
 * origin is used, which is already correct whenever the developer opened the
 * page by its LAN address.
 *
 * No developer-specific address is ever committed: the value comes from
 * configuration or from the address the page was actually served on.
 */
export function resolveDevQrOrigin(configured: string | null | undefined, pageOrigin: string | null | undefined): DevQrOrigin {
  const raw = (configured ?? "").trim() || (pageOrigin ?? "").trim();
  if (!raw) return { origin: null, problem: "unset" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { origin: null, problem: "malformed" };
  }
  // http/https only: a `wpt://` or `file://` origin would not be openable by a
  // scanner's browser at all.
  if (url.protocol !== "http:" && url.protocol !== "https:") return { origin: null, problem: "malformed" };
  if (isLoopbackHost(url.hostname)) return { origin: null, problem: "loopback" };

  return { origin: url.origin, problem: null };
}

/**
 * The exact string to encode in the dev QR, or null when it must not be drawn.
 *
 * Refuses on both counts that matter: a non-allowlisted phone (this is an
 * allowlist, not a template) and a loopback origin (unreachable from a phone).
 */
export function buildDevTestLoginUrl(origin: string | null | undefined, phone: string | null | undefined): string | null {
  const entry = devTestPhone(phone);
  if (!entry) return null;
  const resolved = resolveDevQrOrigin(origin, null);
  if (resolved.problem) return null;
  const digits = normalizeDevPhone(phone);
  return `${resolved.origin}${DEV_TEST_LOGIN_PATH}?phone=${digits}`;
}

/** Human-readable reason the dev QR is unavailable, or null when it is fine. */
export function devQrUnavailableReason(resolved: DevQrOrigin): string | null {
  if (resolved.problem === "loopback") {
    return "This page is open on localhost, which a phone resolves to itself. Set NEXT_PUBLIC_DEV_QR_ORIGIN to this computer's LAN address and reload.";
  }
  if (resolved.problem === "malformed") {
    return "NEXT_PUBLIC_DEV_QR_ORIGIN is not a valid http(s) address.";
  }
  if (resolved.problem === "unset") {
    return "No address to build a test-login link from.";
  }
  return null;
}
