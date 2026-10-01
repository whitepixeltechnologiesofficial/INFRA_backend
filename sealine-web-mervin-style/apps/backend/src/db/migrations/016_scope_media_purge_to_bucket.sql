-- ============================================================
-- BE-R2.4 (migration 016): purge Supabase Storage media together
-- with expired report evidence.  TAD S15.4 (auto-purge), S11.4.
--
-- PROBLEM
--   run_data_cleanup() (migration 009) hard-deletes expired
--   report_evidence rows. Any media file the row pointed to stayed
--   in Storage forever (orphaned). The relay-side Storage trigger
--   cannot be reused: Supabase's storage.protect_delete guard blocks
--   direct DELETEs on storage.objects, so files can only be removed
--   through the Storage API (done by the Node job
--   apps/backend/src/jobs/purge-evidence-media.ts).
--
-- WHAT THIS MIGRATION DOES
--   1) Adds media_bucket + media_path to report_evidence and
--      test_report_evidence (TAD S16.3 test/production mirror).
--      Both NULL = no media. Both set = a Storage object exists.
--   2) run_data_cleanup() no longer deletes an expired row while it
--      still references a media file. The Node job removes the
--      file first, then deletes the row. Rows WITHOUT media are
--      deleted exactly as before.
--
-- Additive + idempotent. Safe to re-run in the Supabase SQL editor.
-- Depends on: 009 (purged_at, run_data_cleanup), 014.
-- ============================================================

BEGIN;

-- 1) Media columns -------------------------------------------------
ALTER TABLE public.report_evidence
    ADD COLUMN IF NOT EXISTS media_bucket text,
    ADD COLUMN IF NOT EXISTS media_path   text;

ALTER TABLE public.test_report_evidence
    ADD COLUMN IF NOT EXISTS media_bucket text,
    ADD COLUMN IF NOT EXISTS media_path   text;

-- Bucket and path must be set together (a path without a bucket
-- could never be deleted).
DO $$
BEGIN
    ALTER TABLE public.report_evidence
        ADD CONSTRAINT report_evidence_media_pair_chk
        CHECK ((media_bucket IS NULL) = (media_path IS NULL));
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE public.test_report_evidence
        ADD CONSTRAINT test_report_evidence_media_pair_chk
        CHECK ((media_bucket IS NULL) = (media_path IS NULL));
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_report_evidence_media_pending
    ON public.report_evidence (captured_at) WHERE media_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_test_report_evidence_media_pending
    ON public.test_report_evidence (captured_at) WHERE media_path IS NOT NULL;

COMMENT ON COLUMN public.report_evidence.media_bucket IS
    'Supabase Storage bucket of the attached media object. NULL = no media. Removed by the purge-evidence-media job (BE-R2.4).';
COMMENT ON COLUMN public.report_evidence.media_path IS
    'Object path inside media_bucket. NULL = no media.';

-- 2) run_data_cleanup(): same as 009 except the evidence DELETE ----
CREATE OR REPLACE FUNCTION public.run_data_cleanup()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_evidence_old   integer;  -- rows marked purged this run
    v_evidence_gone  integer;  -- rows deleted this run (no media)
    v_media_pending  integer;  -- expired rows kept until the media job removes their file
    v_cooldowns      integer;  -- phone cooldowns released this run
BEGIN
    -- S15.4: mark evidence purged strictly at the 30-day boundary.
    UPDATE public.report_evidence
       SET purged_at = now()
     WHERE purged_at IS NULL
       AND captured_at < now() - interval '30 days';
    GET DIAGNOSTICS v_evidence_old = ROW_COUNT;

    -- BE-R2.4: only hard-delete rows that have NO media file left to
    -- clean up. Rows with media_path are deleted by the Node job after
    -- their Storage object is confirmed gone.
    DELETE FROM public.report_evidence
     WHERE purged_at IS NOT NULL
       AND media_path IS NULL;
    GET DIAGNOSTICS v_evidence_gone = ROW_COUNT;

    SELECT count(*) INTO v_media_pending
      FROM public.report_evidence
     WHERE purged_at IS NOT NULL
       AND media_path IS NOT NULL;

    -- S6.9: release phone-number reuse cooldowns only after they expire.
    DELETE FROM public.phone_reuse_cooldowns
     WHERE cooldown_until <= now();
    GET DIAGNOSTICS v_cooldowns = ROW_COUNT;

    -- Negative checks (deliberate): MUST NOT touch public.blocks or
    -- public.reports.

    RAISE NOTICE 'run_data_cleanup: % evidence marked, % evidence purged (>30d), % awaiting media purge, % cooldowns released (>48h)',
        v_evidence_old, v_evidence_gone, v_media_pending, v_cooldowns;
END;
$$;

COMMENT ON FUNCTION public.run_data_cleanup() IS
    'Daily retention job (DB-2.7, BE-R2.4): (1) mark report_evidence purged at 30 days and delete rows without media (S15.4); rows with media are deleted by the purge-evidence-media job after the Storage object is removed, (2) release phone-reuse cooldowns at 48h (S6.9). Never touches blocks or reports.';

COMMIT;

-- Make the Supabase API (PostgREST) see the new columns immediately.
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verification (run after the migration)
-- ============================================================
-- 1) Columns exist on both tables (expect 4 rows):
--    SELECT table_name, column_name FROM information_schema.columns
--    WHERE table_schema='public'
--      AND table_name IN ('report_evidence','test_report_evidence')
--      AND column_name IN ('media_bucket','media_path')
--    ORDER BY 1,2;
-- 2) Function updated (expect 'media_path IS NULL' in the body):
--    SELECT position('media_path IS NULL' in prosrc) > 0 AS updated
--    FROM pg_proc WHERE proname='run_data_cleanup'
--      AND pronamespace='public'::regnamespace;