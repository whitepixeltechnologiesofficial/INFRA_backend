// The single development/test switch that decides whether sample chat fixtures
// may run. Deliberately its own dependency-free module so the one rule that
// keeps development data out of production can be executed and audited on its
// own (scripts/web-fixtures-verify.js imports this file directly) instead of
// being inferred from a bundle.
//
// This rule FAILS CLOSED. Fixtures are enabled only for an environment that is
// explicitly a non-production one, so an unset, misspelled or unexpected
// NODE_ENV ("PRODUCTION", "prod", "") disables them rather than enabling them:
//
//   development / test  -> fixtures may run
//   anything else       -> fixtures are refused, including every spelling of
//                          production and an absent NODE_ENV
//
// Next.js always inlines NODE_ENV as exactly "development" (next dev) or
// "production" (next build / next start), so a production bundle can never
// satisfy the condition. That is what makes TEST 17 ("a production build does
// not include or activate development sample data") true by construction
// rather than by convention.
//
// NEXT_PUBLIC_CHAT_FIXTURES=0 additionally opts a developer back onto the real
// chat relay while still running a development build.
//
// No fixtures, no secrets and no account data are referenced from this file.

/** True only in an explicitly non-production build that has not opted out. */
export function chatFixturesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") return false;
  return env.NEXT_PUBLIC_CHAT_FIXTURES !== "0";
}

/** Resolved once per bundle. */
export const CHAT_FIXTURES_ENABLED = chatFixturesEnabled();