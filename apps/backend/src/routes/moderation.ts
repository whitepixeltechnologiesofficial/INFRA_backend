/**
 * DB-2.5 — Moderation routes.
 *
 * Dashboard-admin moderation of reported users. Each action
 * (warn / restrict / ban / dismiss) calls the transaction-safe
 * PostgreSQL function public.moderate_report() which updates the
 * report AND writes an audit_log row in the same transaction.
 *
 * Access control: only dashboard admins (auth token contains an
 * `adm: "admin"` claim, see issueAdminToken/verifyAdminToken) can
 * call these endpoints. End-user tokens are rejected.
 */

import { Router, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { dashboardAdmins } from "../db/dashboard-admins-schema.js";
import { reports } from "../db/reports-schema.js";
import { verifyAdminToken } from "../auth/jwt.js";

const router: Router = Router();

/**
 * Admin auth middleware — verifies an admin JWT (has `adm: "admin"`
 * claim, no deviceId/sid). Sets res.locals.auth.sub = adminId.
 */
type AdminMiddleware = (
  req: Request,
  res: Response,
  next: () => void,
) => Promise<void> | void;

const requireAdmin: AdminMiddleware = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "MISSING_ADMIN_TOKEN" });
    return;
  }

  const token = header.slice(7);
  try {
    const { adminId } = await verifyAdminToken(token);
    res.locals.auth = { sub: adminId, deviceId: "", sid: "" } as never;
    next();
  } catch {
    res.status(401).json({ error: "INVALID_ADMIN_TOKEN" });
  }
};

// All moderation routes require an admin token.
router.use(requireAdmin as unknown as Parameters<typeof router.use>[0]);

/** Validate the request shape. actor is always the authenticated admin token. */
function parsePayload(body: unknown): { ok: true; reportId: string } | { ok: false; error: string } {
  const b = body as { reportId?: string };
  if (typeof b !== "object" || b === null) {
    return { ok: false, error: "Invalid request body" };
  }
  if (typeof b.reportId !== "string" || !b.reportId) {
    return { ok: false, error: "reportId is required" };
  }
  return { ok: true, reportId: b.reportId };
}

async function runModeration(
  action: "warn" | "restrict" | "ban" | "dismiss",
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const parsed = parsePayload(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    // The acting admin is taken from the verified admin JWT (sub), never
    // from the request body. Prevents admin-impersonation in the audit trail.
    const actorAdminId: string = res.locals.auth!.sub;
    if (typeof actorAdminId !== "string" || !actorAdminId) {
      res.status(401).json({ error: "INVALID_ADMIN_TOKEN" });
      return;
    }

    const db = getDb();

    // Security: bound parameters only — no raw string interpolation.
    // (Previously sql.raw() allowed SQL injection via adminId/reportId.)
    const [adminRow] = await db
      .select({ id: dashboardAdmins.id })
      .from(dashboardAdmins)
      .where(eq(dashboardAdmins.id, actorAdminId))
      .limit(1);

    if (!adminRow) {
      res.status(404).json({ error: "ADMIN_NOT_FOUND" });
      return;
    }

    // Verify the report exists (bound parameter).
    const [reportRow] = await db
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.id, parsed.reportId))
      .limit(1);

    if (!reportRow) {
      res.status(404).json({ error: "REPORT_NOT_FOUND" });
      return;
    }

    // Call the transaction-safe PostgreSQL moderation function — both
    // values are passed as bound parameters (safe parameterization).
    await db.execute(
      sql`SELECT public.moderate_report(${parsed.reportId}::uuid, ${actorAdminId}::uuid, ${action}::public.audit_action)`,
    );

    res.json({ success: true, action, reportId: parsed.reportId });
  } catch (err) {
    console.error(`POST /moderation/${action} error`, err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ──────────────────────────────────────────────────
// POST /moderation/warn
// ──────────────────────────────────────────────────
router.post("/warn", (req: Request, res: Response) => runModeration("warn", req, res));

// ──────────────────────────────────────────────────
// POST /moderation/restrict
// ──────────────────────────────────────────────────
router.post("/restrict", (req: Request, res: Response) => runModeration("restrict", req, res));

// ──────────────────────────────────────────────────
// POST /moderation/ban
// ──────────────────────────────────────────────────
router.post("/ban", (req: Request, res: Response) => runModeration("ban", req, res));

// ──────────────────────────────────────────────────
// POST /moderation/dismiss
// ──────────────────────────────────────────────────
router.post("/dismiss", (req: Request, res: Response) => runModeration("dismiss", req, res));

export default router;