/**
 * Phone -> account resolution.
 *
 * Lives outside src/web-link on purpose. R1.7's structural guard asserts that no
 * seam in the linking protocol can reach the mobile session store (`src/db`), and
 * that guard is load-bearing, so it is not to be relaxed: an account resolver that
 * queries `users` is a real concern of its own and gets its own module, the same
 * way the realtime provider bottle queries the DB from src/messages.
 *
 * WHY THIS EXISTS
 *
 * `approve` binds a Web session to an ACCOUNT, and in production that account
 * arrives in the mobile JWT (`sub`), never in a request body (R1.3/R1.4). The
 * development trigger stands in for a phone, so somebody has to name the
 * account. When that name came from the caller -- a hard-coded userId in the
 * Web client -- the flow was only *reproducible*: the session belonged to
 * whatever the frontend happened to assert, which is the same body-trust that
 * R1.3 forbids everywhere else.
 *
 * So the lookup moved to where the account actually lives. The authoritative
 * source is the `users` table: `phone_number` (E.164, unique) -> `id` + `name`.
 * That is the same lookup OTP-verify already performs when it decides whether a
 * verified number is an existing account, so the dev flow and the real flow now
 * answer from one source of truth.
 *
 * There is deliberately NO fallback account and no name synthesis: a number that
 * is not in the user store resolves to null and the caller is told so.
 *
 * The seam is overridable (`overrideAccountLookup`) exactly like the realtime
 * provider bottle in ../messages/providers.ts, so a verification harness can run
 * this logic with no database.
 */

import { eq } from "drizzle-orm";

/** An account as the linking protocol needs it: an id and a display name. */
export interface MobileAccount {
  userId: string;
  accountName: string;
}

export type AccountLookup = (e164: string) => Promise<MobileAccount | null>;

/**
 * The real account store. Lazy import, like the DB-backed provider defaults, so
 * importing this module never opens a connection.
 */
async function dbLookupByPhone(e164: string): Promise<MobileAccount | null> {
  const { getDb } = await import("../db/index.js");
  const { users } = await import("../db/users-schema.js");
  const rows = await getDb()
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.phoneNumber, e164))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { userId: String(row.id), accountName: String(row.name ?? "") };
}

let lookup: AccountLookup = dbLookupByPhone;

/** Inject a deterministic account source for tests. `resetAccountLookup()` restores the DB. */
export function overrideAccountLookup(fn: AccountLookup): void {
  lookup = fn;
}

export function resetAccountLookup(): void {
  lookup = dbLookupByPhone;
}

/**
 * E.164 shape only. `users.phone_number` holds E.164 (varchar(20)), which is
 * what the mobile client normalizes to before OTP send, so an equality lookup
 * is correct and needs no libphonenumber guessing about the default country.
 */
export const E164_SHAPE = /^\+[1-9]\d{7,14}$/;

export type AccountLookupResult =
  | { ok: true; account: MobileAccount; phoneNumber: string }
  | { ok: false; error: "invalid_phone" | "account_not_found"; message: string };

/**
 * Resolve a phone number to a real account, or explain why it cannot be.
 *
 * Never guesses: no default country, no prefix stripping, no "create the
 * account on demand" (that is OTP verify's job, and it would mint an identity
 * nobody asked for).
 */
export async function resolveAccountByPhone(raw: unknown): Promise<AccountLookupResult> {
  const phoneNumber = typeof raw === "string" ? raw.trim() : "";
  if (!E164_SHAPE.test(phoneNumber)) {
    return {
      ok: false,
      error: "invalid_phone",
      message:
        "phoneNumber must be E.164 (for example +919876543210); it is compared with users.phone_number exactly as OTP verify stores it.",
    };
  }
  const account = await lookup(phoneNumber);
  if (!account) {
    return {
      ok: false,
      error: "account_not_found",
      message: `No account exists for ${phoneNumber} in the backend user store. Sign that number in once through the normal OTP flow, then retry.`,
    };
  }
  return { ok: true, account, phoneNumber };
}
