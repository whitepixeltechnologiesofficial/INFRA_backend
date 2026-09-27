/**
 * Environment checks that must fail closed.
 *
 * The pattern these replace was:
 *
 *     if (process.env.NODE_ENV === "production") { refuse }
 *
 * That is a DENYLIST, and a denylist only protects the one string it names.
 * `NODE_ENV=prod`, `NODE_ENV=Production`, `NODE_ENV=staging`, a preview
 * environment, or a container that simply never sets it all sail straight
 * through — so the guard was effectively off everywhere except the exact
 * spelling of one value. For a check whose whole job is to prevent an
 * unrecoverable action, that is the worst possible default.
 *
 * These helpers invert it: an ALLOWLIST. Anything not positively identified as a
 * local development or test context is refused, and the refusal says what to set
 * so the operator is not left guessing.
 */

/** The only NODE_ENV values treated as a local, non-production context. */
const SAFE_ENVIRONMENTS = new Set(["development", "test"]);

function normalized(env: string | undefined): string {
  return (env ?? "").trim().toLowerCase();
}

/**
 * True only when NODE_ENV positively names a local development or test context.
 *
 * Unset is NOT safe by default. Callers that must run with NODE_ENV unset should
 * set it explicitly — that is a one-line change, and requiring it is what makes
 * the check meaningful.
 */
export function isLocalDevEnvironment(env: string | undefined = process.env.NODE_ENV): boolean {
  return SAFE_ENVIRONMENTS.has(normalized(env));
}

/**
 * Reason string for refusing, or null when the environment is safe.
 * Kept separate so callers can produce their own message wording while sharing
 * one definition of "safe".
 */
export function unsafeEnvironmentReason(
  env: string | undefined = process.env.NODE_ENV,
): string | null {
  if (isLocalDevEnvironment(env)) return null;
  const current = env ? `"${env}"` : "is not set";
  return (
    `NODE_ENV ${current}, which is not a recognised local development context. ` +
    `Only ${[...SAFE_ENVIRONMENTS].map((e) => `"${e}"`).join(" and ")} are permitted. ` +
    `Set NODE_ENV=development to proceed.`
  );
}
