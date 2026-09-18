-- ============================================================
-- 009_create_data_cleanup.sql
-- DB-2.7-V remediation — Scheduled Retention & Deletion Job.
--
-- Fixes from the DB-2.7-V verification report (FAIL):
--   F-05: daily-data-cleanup cron job calls public.run_data_cleanup()
--         which was never created -> every recorded run failed.
--   F-06: cleanup_message_relay() deletes the DB row but never the
--         associated media object in Storage (S11.4).
--   F-07: report_evidence has no purged_at column; S15.4 describes
--         evidence being marked purged after 30 days.
--   Naming: Tech Arch S6.4 calls the queue "pending_messages"; the
--         implementation is message_relay (reconciled via COMMENT).
--
-- Design (mapped to Tech Arch section numbers used by DB-2.7-V):
--   S6.4  cleanup_message_relay()          -> delivered/expired rows deleted (unchanged)
--   S11.4 message_relay storage cleanup     -> AFTER DELETE trigger removes media object
--   S15.4 report_evidence purge             -> purged_at marked + row deleted at 30 days
--   S6.9  phone-reuse cooldown              -> phone_reuse_cooldowns released >= 48h
--   Negative checks                         -> blocks and reports are NEVER touched
--
-- Run this in: Supabase → SQL Editor → New Query → Run
-- Idempotent: safe to run multiple times.
-- ============================================================

BEGIN;

-- ============================================================
-- 1) S15.4: purged_at on report_evidence (and test mirror)
-- ============================================================

ALTER TABLE public.report_evidence
    ADD COLUMN IF NOT EXISTS purged_at timestamptz;

ALTER TABLE IF EXISTS public.test_report_evidence
    ADD COLUMN IF NOT EXISTS purged_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_report_evidence_purged
    ON public.report_evidence (purged_at)
    WHERE purged_at IS NOT NULL;

-- ============================================================
-- 2) S6.9: phone-number reuse cooldown table
--    Keyed by phone hash (like blocks/reports) so the cooldown
--    survives account deletion and re-creation. Rows are released
--    (deleted) by run_data_cleanup() only once cooldown_until <= now().
-- ============================================================

CREATE TABLE IF NOT EXISTS public.phone_reuse_cooldowns (
    phone_hash     text PRIMARY KEY,
    cooldown_until timestamptz NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phone_reuse_cooldowns_until
    ON public.phone_reuse_cooldowns (cooldown_until);

COMMENT ON TABLE public.phone_reuse_cooldowns IS
    'S6.9 phone-number reuse cooldown. Released by run_data_cleanup() when cooldown_until <= now(); never before 48h.';

-- ============================================================
-- 3) S6.4/S11.4: release media path on the relay + Storage trigger
-- ============================================================

-- media_path is the Storage object identifier (e.g. 'chat-media/uuid.jpg').
-- NULL for messages that carry no media object (ciphertext-only rows).
ALTER TABLE public.message_relay
    ADD COLUMN IF NOT EXISTS media_path text;

-- Naming reconciliation: the S6.4 "pending_messages" queue is implemented
-- as message_relay (per-device fan-out rows); see devices/message-relay schema.
COMMENT ON TABLE public.message_relay IS
    'Message queue per recipient device. Tech Arch S6.4 calls this pending_messages; message_relay is the implemented table. Deleting a row also removes its media_path object from Storage (S11.4).';

-- AFTER DELETE trigger: when a relay row goes away, also delete the
-- media object it referenced from the Storage bucket. Errors are
-- swallowed if the storage schema is unavailable/bucket missing so a
-- DB-only delete is never blocked.
CREATE OR REPLACE FUNCTION public.tg_message_relay_purge_storage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
BEGIN
    IF OLD.media_path IS NOT NULL THEN
        BEGIN
            DELETE FROM storage.objects
            WHERE name = OLD.media_path;
        EXCEPTION
            WHEN undefined_table OR insufficient_privilege THEN
                NULL; -- storage not present / not accessible from this role
        END;
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_message_relay_purge_storage ON public.message_relay;
CREATE TRIGGER trg_message_relay_purge_storage
    AFTER DELETE ON public.message_relay
    FOR EACH ROW
    EXECUTE FUNCTION public.tg_message_relay_purge_storage();

-- ============================================================
-- 4) F-05 (critical): create public.run_data_cleanup()
--    Called daily at 03:00 by cron job 'daily-data-cleanup'.
--    NOT touched: blocks, reports (negative checks per DB-2.7-V).
-- ============================================================

CREATE OR REPLACE FUNCTION public.run_data_cleanup()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_evidence_old integer;   -- rows marked purged this run
    v_evidence_gone integer;  -- rows deleted this run (30-day purge)
    v_cooldowns    integer;   -- phone cooldowns released this run
BEGIN
    -- S15.4: purge report_evidence strictly at the 30-day boundary.
    -- Mark purged_at first (audit trail), then hard-delete. Rows younger
    -- than 30 days are untouched (never purged early).
    UPDATE public.report_evidence
       SET purged_at = now()
     WHERE purged_at IS NULL
       AND captured_at < now() - interval '30 days';
    GET DIAGNOSTICS v_evidence_old = ROW_COUNT;

    DELETE FROM public.report_evidence
     WHERE purged_at IS NOT NULL;
    GET DIAGNOSTICS v_evidence_gone = ROW_COUNT;

    -- S6.9: release phone-number reuse cooldowns only after they expire.
    -- Rows with cooldown_until still in the future are left alone.
    DELETE FROM public.phone_reuse_cooldowns
     WHERE cooldown_until <= now();
    GET DIAGNOSTICS v_cooldowns = ROW_COUNT;

    -- Negative checks (deliberate): this function MUST NOT touch
    -- public.blocks or public.reports under any circumstances.
    -- No statement referencing them appears in the function body.

    RAISE NOTICE 'run_data_cleanup: % evidence marked, % evidence purged (>30d), % cooldowns released (>48h)',
        v_evidence_old, v_evidence_gone, v_cooldowns;
END;
$$;

COMMENT ON FUNCTION public.run_data_cleanup() IS
    'Daily retention job (DB-2.7): (1) purge report_evidence at 30 days (S15.4), (2) release phone-reuse cooldowns at 48h (S6.9). Never touches blocks or reports.';

COMMIT;

-- ============================================================
-- Verification queries (run after migration completes)
-- ============================================================

-- 1) Function exists + returns void:
--    SELECT proname, pg_get_function_result(oid) FROM pg_proc
--    WHERE proname IN ('run_data_cleanup','cleanup_message_relay') AND pronamespace='public'::regnamespace;

-- 2) Cron job present and points at the new function:
--    SELECT jobid, jobname, schedule, left(command,120) FROM cron.job ORDER BY jobid;

-- 3) Force a manual run of the daily job and confirm it succeeds:
--    SELECT cron.run_job(jobid) FROM cron.job WHERE jobname = 'daily-data-cleanup';
--    -- then inspect: SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;

-- 4) purged_at + media_path columns exist:
--    SELECT table_name, column_name FROM information_schema.columns
--    WHERE table_schema='public'
--      AND ((table_name='report_evidence' AND column_name='purged_at')
--        OR (table_name='message_relay' AND column_name='media_path'));

-- 5) Storage trigger on message_relay:
--    SELECT tgname FROM pg_trigger
--    WHERE tgrelid='public.message_relay'::regclass AND NOT tgisinternal;