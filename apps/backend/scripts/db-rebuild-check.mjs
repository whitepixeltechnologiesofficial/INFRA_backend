// apps/backend/scripts/db-rebuild-check.mjs
//
// Builds the WHOLE database from an EMPTY Postgres using only the files in the repo.
// It never touches the live Supabase database.
//
// How to run (from the repo root):
//   1. Have a local Postgres running (any version 15 or 16).
//   2. Set REBUILD_ADMIN_URL to your LOCAL Postgres, for example:
//        Windows PowerShell:  $env:REBUILD_ADMIN_URL="postgres://postgres:postgres@localhost:5432/postgres"
//        macOS / Linux:       export REBUILD_ADMIN_URL="postgres://postgres:postgres@localhost:5432/postgres"
//   3. pnpm --filter @wpt/backend exec node scripts/db-rebuild-check.mjs
//
// Result: "ALL MIGRATIONS OK" and exit code 0, or the first file that failed and its error.

import pg from "pg";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "src", "db", "migrations");
const stubsFile = join(here, "..", "src", "db", "test-stubs", "local-supabase-stubs.sql");
const adminUrl = process.env.REBUILD_ADMIN_URL || "postgres://postgres:postgres@localhost:5432/postgres";
const DB = "wpt_rebuild_check";

if (/supabase.(co|com)/i.test(adminUrl)) {
  console.error("STOP: REBUILD_ADMIN_URL points at Supabase. Use a LOCAL Postgres only.");
  process.exit(2);
}

let parsedAdminUrl;
try {
  parsedAdminUrl = new URL(adminUrl);
} catch {
  console.error("STOP: REBUILD_ADMIN_URL is not a valid URL. Use a LOCAL Postgres host.");
  process.exit(2);
}

const adminHost = parsedAdminUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
const allowedLocalHosts = new Set(["localhost", "127.0.0.1", "::1"]);

if (!allowedLocalHosts.has(adminHost)) {
  console.error("STOP: REBUILD_ADMIN_URL must use a LOCAL Postgres host (localhost, 127.0.0.1, or ::1).");
  process.exit(2);
}

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();

const url = new URL(adminUrl);
url.pathname = "/" + DB;
const db = new pg.Client({ connectionString: url.toString() });
await db.connect();

const files = [];
if (existsSync(stubsFile)) files.push(stubsFile);
for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
  files.push(join(migrationsDir, f));
}

let failed = false;
for (const file of files) {
  const name = file.split(/[\/]/).pop();
  try {
    await db.query(readFileSync(file, "utf8"));
    console.log("  ok   " + name);
  } catch (err) {
    console.log("  FAIL " + name + "  ->  " + err.message);
    failed = true;
    break;
  }
}
await db.end();

if (failed) {
  console.log("\nFIX the file above, then run this script again.");
  process.exit(1);
}
console.log("\nALL MIGRATIONS OK");
