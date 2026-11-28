/**
 * Legal-acceptance gate enforcement (ONB-1.3).
 *
 * The OTP verification endpoint calls `requireLegalAcceptance`
 * BEFORE allowing the code to be checked. If no row exists in
 * `legal_acceptances` for this phone number, the endpoint rejects
 * the request — regardless of what the client sent.
 *
 * This prevents a technically savvy user from bypassing the UI
 * screen order and calling the verify-OTP endpoint directly.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { legalAcceptances } from "../db/legal-acceptances-schema.js";

/**
 * The version of the legal documents currently in force.
 *
 * Single source of truth — `hasAcceptedLegal` compares against this, so
 * bumping it here re-prompts every existing user on their next sign-in.
 * TAD §6.8 stores this as `legal_acceptances.document_version`; PRD §5.1
 * lists versioned consent tracking for material Terms/Privacy updates.
 */
export const CURRENT_LEGAL_VERSION = "v1.1";

/**
 * Record that a user has accepted the legal terms.
 *
 * Called by the accept-legal endpoint (ONB-1.3 UI flow).
 * Upserts so that re-acceptance after a version change is idempotent.
 */
export async function recordLegalAcceptance({
  phoneNumber,
  legalVersion = CURRENT_LEGAL_VERSION,
}: {
  phoneNumber: string;
  legalVersion?: string;
}): Promise<void> {
  const db = getDb();

  await db
    .insert(legalAcceptances)
    .values({
      phoneNumber,
      legalVersion,
      acceptedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: legalAcceptances.phoneNumber,
      set: {
        legalVersion,
        acceptedAt: new Date(),
      },
    });
}

/**
 * Check whether a phone number has accepted the legal terms currently
 * in force.
 *
 * Returns `true` only if a row exists for this phone number AND its
 * stored `legalVersion` matches the current version. A user who accepted
 * an earlier version is treated as not having accepted, so they are
 * re-prompted after any material change to the Terms or Privacy Policy.
 *
 * @param legalVersion version to require — defaults to CURRENT_LEGAL_VERSION
 */
export async function hasAcceptedLegal(
  phoneNumber: string,
  legalVersion: string = CURRENT_LEGAL_VERSION,
): Promise<boolean> {
  const db = getDb();

  const [row] = await db
    .select({ legalVersion: legalAcceptances.legalVersion })
    .from(legalAcceptances)
    .where(eq(legalAcceptances.phoneNumber, phoneNumber))
    .limit(1);

  return row?.legalVersion === legalVersion;
}

/**
 * Gate check — throws if legal acceptance is missing or stale.
 *
 * This is the function the OTP-verify endpoint calls. It does NOT
 * return a boolean — it throws a descriptive error so the endpoint
 * can map it to the appropriate HTTP response.
 *
 * @param legalVersion version to require — defaults to CURRENT_LEGAL_VERSION
 */
export async function requireLegalAcceptance(
  phoneNumber: string,
  legalVersion: string = CURRENT_LEGAL_VERSION,
): Promise<void> {
  const accepted = await hasAcceptedLegal(phoneNumber, legalVersion);
  if (!accepted) {
    throw new LegalAcceptanceRequiredError(phoneNumber, legalVersion);
  }
}

export class LegalAcceptanceRequiredError extends Error {
  readonly code = "LEGAL_NOT_ACCEPTED" as const;
  readonly statusCode = 403;

  constructor(phoneNumber: string, legalVersion: string) {
    // The phone number is deliberately NOT embedded here — this message
    // reaches logs and can surface in an HTTP response body. It is
    // available on the instance for server-side logging instead.
    super(
      `OTP verification rejected: no acceptance of legal version ` +
        `${legalVersion} on record. The client must call the accept-legal ` +
        `endpoint before retrying.`,
    );
    this.name = "LegalAcceptanceRequiredError";
    Object.defineProperty(this, "phoneNumber", {
      value: phoneNumber,
      enumerable: false,
    });
  }
}
