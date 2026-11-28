/**
 * BE-R2.4 - Purge Supabase Storage media for expired report evidence.
 * TAD S15.4 (auto-purge), S11.4 (Storage cleanup).
 *
 * Why this is a Node job and not SQL: Supabase blocks direct DELETEs on
 * storage.objects (storage.protect_delete), so files can only be removed
 * through the Storage API.
 *
 * Why rows are read/deleted over a direct Postgres connection and not the
 * Supabase API: the public schema is deliberately closed to the API roles
 * (anon, authenticated, service_role have no USAGE on it). The Supabase API
 * is used ONLY for the Storage delete.
 *
 * For every expired evidence row that still references a media file:
 *   1. Delete the Storage object.
 *        - "file not found" is SUCCESS (already deleted manually, or never
 *          uploaded because of an earlier bug) - the job does not crash.
 *        - any other Storage error => the row is KEPT and retried next run.
 *   2. Only after step 1 succeeded, delete the database row.
 *        - if this fails, the file is already gone; the next run finds it
 *          "already gone" and retries the row delete.
 * So neither half can be lost without the other being retried.
 *
 * "Expired" = purged_at is set OR captured_at is older than 30 days, so the
 * job does not depend on the exact timing of run_data_cleanup().
 *
 * Env (never commit values): DATABASE_URL, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY.
 * Exit code 1 if anything failed, so a scheduled run shows as failed.
 */

import pg from "pg";
import { createClient } from "@supabase/supabase-js";

const EVIDENCE_TABLES = ["public.report_evidence", "test.test_report_evidence"] as const;
const BATCH_LIMIT = 500;
const EXPIRED_SQL =
  "(purged_at IS NOT NULL OR captured_at < now() - interval '30 days')";

interface MediaRow {
  id: string;
  media_bucket: string;
  media_path: string;
}

interface PurgeResult {
  removed: number;
  alreadyGone: number;
  failed: number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "purge-evidence-media: DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
    );
    process.exitCode = 1;
    return;
  }

  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost")
      ? undefined
      : { rejectUnauthorized: false },
  });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const result: PurgeResult = { removed: 0, alreadyGone: 0, failed: 0 };

  try {
    for (const table of EVIDENCE_TABLES) {
      const { rows } = await pool.query<MediaRow>(
        `SELECT id, media_bucket, media_path
           FROM ${table}
          WHERE media_path IS NOT NULL AND ${EXPIRED_SQL}
          ORDER BY captured_at
          LIMIT ${BATCH_LIMIT}`,
      );

      for (const row of rows) {
        // Step 1: Storage object first.
        const { data: removedObjects, error: storageError } =
          await supabase.storage
            .from(row.media_bucket)
            .remove([row.media_path]);

        if (storageError) {
          result.failed += 1;
          console.error(
            `[${table}] ${row.id}: Storage delete failed, row kept for retry: ${storageError.message}`,
          );
          continue;
        }
        if ((removedObjects?.length ?? 0) > 0) {
          result.removed += 1;
        } else {
          result.alreadyGone += 1; // nothing to delete = fine
        }

        // Step 2: database row, only after Storage succeeded.
        try {
          await pool.query(
            `DELETE FROM ${table} WHERE id = $1 AND ${EXPIRED_SQL}`,
            [row.id],
          );
        } catch (err) {
          result.failed += 1;
          console.error(
            `[${table}] ${row.id}: file removed but row delete failed, will retry: ${errMsg(err)}`,
          );
        }
      }
    }
  } finally {
    await pool.end();
  }

  console.log(
    `purge-evidence-media: ${result.removed} files removed, ${result.alreadyGone} already gone, ${result.failed} failures`,
  );
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`purge-evidence-media: fatal: ${errMsg(err)}`);
  process.exitCode = 1;
});