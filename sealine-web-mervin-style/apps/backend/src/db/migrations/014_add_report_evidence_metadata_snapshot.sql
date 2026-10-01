-- ============================================================
-- 014_add_report_evidence_metadata_snapshot.sql
-- BE-R2.3: add metadata_snapshot to report_evidence.
--
-- Tech Arch S6.6 (the card referenced S6.7, which is actually
-- dashboard_admins/audit_log -- report_evidence is documented
-- under S6.6, corrected here).
--
-- purged_at already exists (added in 009_create_data_cleanup.sql,
-- S15.4) and is NOT touched by this migration. The 30-day purge
-- of overdue rows is already handled by run_data_cleanup(); this
-- migration adds no new purge logic (that remains BE-R2.4's scope,
-- and only for any future report_evidence media path, which does
-- not exist yet).
--
-- Run this in: Supabase -> SQL Editor -> New Query -> Run
-- Idempotent: safe to run multiple times.
-- ============================================================

BEGIN;

ALTER TABLE public.report_evidence
    ADD COLUMN IF NOT EXISTS metadata_snapshot jsonb;

ALTER TABLE IF EXISTS public.test_report_evidence
    ADD COLUMN IF NOT EXISTS metadata_snapshot jsonb;

COMMIT;

-- ============================================================
-- Verification queries (run after migration completes)
-- ============================================================

-- 1) Column exists, correct type, nullable:
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_name = 'report_evidence' AND column_name = 'metadata_snapshot';

-- 2) Insert accepts a structured object, purged_at stays untouched:
-- INSERT INTO public.report_evidence (report_id, message_created_at, metadata_snapshot)
-- VALUES ('<existing report id>', now(), '{"message_type":"text","size_bytes":128}'::jsonb)
-- RETURNING id, metadata_snapshot, purged_at;

-- 3) Confirm existing overdue rows are still correctly picked up by the
--    existing purge job (no change expected from this migration):
-- SELECT count(*) FROM public.report_evidence
-- WHERE purged_at IS NULL AND captured_at < now() - interval '30 days';
