import { redactUrl } from "./pool.js";
import { unsafeEnvironmentReason } from "../config/safe-env.js";

/**
 * Gate for scripts that drop, delete or rewrite live auth state.
 *
 * `sessions` and `legal_acceptances` are read on the hot path of every refresh and
 * every OTP verification, and `legal_acceptances` is the consent audit trail, so an
 * accidental run against a shared database is unrecoverable. These scripts must opt
 * in explicitly, and remote targets need a second acknowledgement.
 */
export function assertDestructiveAllowed(action: string, statements: string[]): void {
  // Allowlist, not `NODE_ENV === "production"`. That denylist let `staging`,
  // `prod`, and an unset NODE_ENV through, which is every environment where this
  // script is most dangerous and least expected to be blocked.
  const unsafe = unsafeEnvironmentReason();
  if (unsafe) {
    throw new Error(
      `${action} refused: ${unsafe}\n` +
        `This script destroys live auth state and must never run against a shared ` +
        `or production database.`,
    );
  }

  if (process.env.ALLOW_DESTRUCTIVE_DB !== "true") {
    throw new Error(
      `${action} refused: destructive database scripts are opt-in.\n` +
        `Set ALLOW_DESTRUCTIVE_DB=true to run this against a throwaway database.`,
    );
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(`${action} refused: DATABASE_URL is not set`);
  }

  const host = new URL(connectionString).hostname;
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(host.toLowerCase());

  if (!isLocal && process.env.ALLOW_DESTRUCTIVE_DB_REMOTE !== "true") {
    throw new Error(
      `${action} refused: the target is REMOTE (${redactUrl(connectionString)}).\n` +
        `This will run against a shared database. If you are certain that is intended, re-run with ` +
        `ALLOW_DESTRUCTIVE_DB_REMOTE=true.\n\n` +
        `Statements this script will execute:\n` +
        statements.map((s) => `  - ${s}`).join("\n"),
    );
  }

  console.warn(
    `\n[guard] ${action} proceeding against ${redactUrl(connectionString)} (${host})\n` +
      statements.map((s) => `[guard]   - ${s}`).join("\n"),
  );
}
