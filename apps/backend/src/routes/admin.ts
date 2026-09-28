/**
 * DB-2.5 — Dashboard admin authentication.
 *
 * POST /admin/login  — email + password against dashboard_admins
 *                      (bcrypt verify), returns a short-lived admin
 *                      token used for /moderation/* calls.
 *
 * Tokens are minted with `adm: "admin"` and no deviceId/sid claims
 * (see issueAdminToken) so end-user tokens are never confused with
 * admin tokens.
 */

import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { getDb } from "../db/index.js";
import { dashboardAdmins } from "../db/dashboard-admins-schema.js";
import { issueAdminToken, verifyAdminToken } from "../auth/jwt.js";
import { rateLimit } from "../middleware/rate-limit.js";

const router: Router = Router();

// ──────────────────────────────────────────────────
// POST /admin/login
// Body: { email: string, password: string }
// 200 -> { success: true, adminId, role, email, token, expiresIn }
// 400 -> { error: "email and password are required" }
// 401 -> { error: "INVALID_CREDENTIALS" }
// 429 -> { error: "RATE_LIMITED" }
// 500 -> { error: "Internal server error" }
//
// This router is intentionally NOT mounted (see app.ts). The rate limit below
// exists so that mounting it is not the moment unlimited online password
// guessing against dashboard_admins becomes reachable: the limiter is attached
// to the handler, not to the mount point, so it protects the route wherever it
// is eventually wired up.
//
// Two limits, because either alone is insufficient — an IP cap alone does not
// stop a distributed or botnet sweep, and an email cap alone lets one caller
// spray many addresses. bcrypt-12 makes each guess expensive, which is the
// other half of the defence.
// ──────────────────────────────────────────────────
const adminLoginIpLimit = rateLimit({
  maxRequests: 10,
  windowMs: 15 * 60_000,
  keyFn: (req) => `admin-login:ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`,
  message: "Too many admin login attempts from this network. Try again later.",
});

const adminLoginEmailLimit = rateLimit({
  maxRequests: 5,
  windowMs: 15 * 60_000,
  keyFn: (req) => {
    const email = (req.body as { email?: unknown } | null)?.email;
    return typeof email === "string" && email
      ? `admin-login:email:${email.toLowerCase().trim()}`
      : "admin-login:email:unknown";
  },
  message: "Too many admin login attempts for this account. Try again later.",
});

router.post(
  "/login",
  adminLoginIpLimit,
  adminLoginEmailLimit,
  async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (typeof email !== "string" || !email || typeof password !== "string" || !password) {
      res.status(400).json({ error: "email and password are required" });
      return;
    }

    const db = getDb();
    // Note: email is compared with dates_ci normalization lower() — admin
    // emails are stored lowercase; keep the match case-insensitive.
    const [admin] = await db
      .select({
        id: dashboardAdmins.id,
        email: dashboardAdmins.email,
        role: dashboardAdmins.role,
        passwordHash: dashboardAdmins.passwordHash,
      })
      .from(dashboardAdmins)
      .where(eq(dashboardAdmins.email, email.toLowerCase().trim()))
      .limit(1);

    if (!admin) {
      res.status(401).json({ error: "INVALID_CREDENTIALS" });
      return;
    }

    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) {
      res.status(401).json({ error: "INVALID_CREDENTIALS" });
      return;
    }

    const token = await issueAdminToken(admin.id, "8h");

    res.json({
      success: true,
      adminId: admin.id,
      email: admin.email,
      role: admin.role,
      token,
      expiresIn: "8h",
    });
  } catch (err) {
    console.error("POST /admin/login error", err);
    res.status(500).json({ error: "Internal server error" });
  }
  },
);

// ──────────────────────────────────────────────────
// GET /admin/me
// Auth: Bearer admin token
// 200 -> { adminId, role, email }
// 401 -> { error: "MISSING_ADMIN_TOKEN" | "INVALID_ADMIN_TOKEN" }
// 404 -> { error: "ADMIN_NOT_FOUND" }
// ──────────────────────────────────────────────────
router.get("/me", async (req: Request, res: Response) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "MISSING_ADMIN_TOKEN" });
    return;
  }

  try {
    const { adminId } = await verifyAdminToken(header.slice(7));
    const db = getDb();
    const [admin] = await db
      .select({ id: dashboardAdmins.id, email: dashboardAdmins.email, role: dashboardAdmins.role })
      .from(dashboardAdmins)
      .where(eq(dashboardAdmins.id, adminId))
      .limit(1);

    if (!admin) {
      res.status(404).json({ error: "ADMIN_NOT_FOUND" });
      return;
    }

    res.json({ success: true, adminId: admin.id, email: admin.email, role: admin.role });
  } catch {
    res.status(401).json({ error: "INVALID_ADMIN_TOKEN" });
  }
});

export default router;