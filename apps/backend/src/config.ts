// Startup configuration guard.
//
// Every secret this backend needs is checked ONCE, here, before the server
// accepts a single request. The reason is a real incident, not tidiness:
//
// `JWT_SECRET` signs BOTH the mobile access tokens (auth/jwt.ts) and the
// single-scope socket tickets for web linking (web-link/ticket.ts). A local
// .env carried a differently-named key, so nothing was wrong at boot, the
// server started happily, and the first thing that touched a ticket threw deep
// inside the linking service. The register route caught that, answered 500, and
// logged nothing - so the Web app showed a bare "register_failed" code with no
// server-side trace and no obvious cause.
//
// A missing signing key is a deployment fault, never a runtime condition, so it
// must be loud and immediate rather than deferred to whichever endpoint happens
// to need it first.
//
// Values are checked for PRESENCE only. Nothing here reads, prints, logs or
// otherwise reveals a secret.
import "dotenv/config";

/** Keys that must exist for the process to be able to serve its API. */
const REQUIRED_SECRETS = ["JWT_SECRET"] as const;

/** Non-secret settings worth catching early, because they silently degrade behaviour. */
const REQUIRED_URLS = ["DATABASE_URL"] as const;

export interface ConfigProblem {
  key: string;
  why: string;
}

export function findConfigProblems(env: NodeJS.ProcessEnv = process.env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  for (const key of REQUIRED_SECRETS) {
    if (!(env[key] ?? "").trim()) {
      problems.push({
        key,
        why: "signs mobile access tokens and web-link socket tickets; without it every authenticated request and every link registration fails at runtime",
      });
    }
  }
  for (const key of REQUIRED_URLS) {
    if (!(env[key] ?? "").trim()) {
      problems.push({ key, why: "no database configured, so no account can ever be resolved" });
    }
  }
  return problems;
}

/**
 * Throws if required configuration is missing. Call this BEFORE listening, so a
 * misconfigured process never accepts traffic it cannot correctly serve.
 */
export function assertRuntimeConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems = findConfigProblems(env);
  if (problems.length === 0) return;
  const lines = problems.map((p) => `  - ${p.key}: ${p.why}`).join("\n");
  throw new Error(
    `@wpt/backend cannot start: missing required configuration.\n${lines}\n` +
      `Set these in apps/backend/.env (see apps/backend/.env.example). Values are never logged.`,
  );
}