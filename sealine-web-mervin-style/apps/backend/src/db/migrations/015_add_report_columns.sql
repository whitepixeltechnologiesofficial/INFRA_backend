-- ============================================================
-- 015_add_report_columns.sql
-- Sprint 1 audit fix — reports (and test_reports) were missing
-- three columns specified by Tech Arch §6.6:
--   reason_category     enum (report_reason_category)
--   reported_group_id   uuid NULL with FK -> groups(id)
--   evidence_expires_at timestamptz NOT NULL (= created_at + 30d)
--
-- Additive only: no drops of other columns, no renames, no table
-- recreation. Existing rows are preserved and backfilled.
-- Idempotent: safe to re-run in Supabase → SQL Editor.
--
-- reason_category values come from the audit ticket's fallback
-- list. A repo-wide search found NO existing controlled vocabulary
-- to inherit from: POST /reports/file accepts a free-text `reason`
-- string that is never persisted, and no frontend/report form
-- sends preset category values.
--
-- evidence_expires_at = submission time + 30 days, matching the
-- confirmed product rule behind S15.4 (migration 009 purges
-- report_evidence at the 30-day boundary). In this schema the
-- submission timestamp column is created_at.
--
-- Every change below is mirrored onto public.test_reports
-- (test/production isolation: same schema, same database, a
-- parallel table used when the dashboard account is a test
-- account). The mirrored statements use ALTER TABLE IF EXISTS /
-- guarded DO blocks because test_reports may not exist in a brand-
-- new environment (it is created out-of-band, like groups were).
--
-- Run this in: Supabase → SQL Editor → New Query → Run
-- ============================================================

BEGIN;

-- ── 1. Enum report_reason_category ──────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_reason_category') THEN
        CREATE TYPE public.report_reason_category AS ENUM
            ('spam', 'harassment', 'inappropriate_content', 'other');
    END IF;
END
$$;

-- ── 2. reports ──────────────────────────────────────────────

-- reason_category: NOT NULL DEFAULT 'other' — the strongest safe
-- option. Postgres backfills every pre-existing row to 'other'
-- (there is no prior source of truth to backfill more accurately).
-- The DEFAULT is a safety net ONLY: new application-level inserts
-- MUST always supply a real reason_category. Already-shipped
-- inserts at POST /reports/file (which do not set it) keep working
-- because of this default.
ALTER TABLE public.reports
    ADD COLUMN IF NOT EXISTS reason_category public.report_reason_category
    NOT NULL DEFAULT 'other';

-- reported_group_id: uuid NULL + FK -> groups(id) ON DELETE SET NULL.
-- A report is against a user (reported_phone_hash) OR against a group;
-- both targeting columns stay nullable (mutually exclusive in practice;
-- no CHECK added — the reports table has no user+group row pattern of
-- its own to copy, and reported_group_id is a straight FK).
-- SET NULL (NOT CASCADE): a report must survive even after the reported
-- group is deleted — group deletion never auto-dismisses a pending report
-- (admin dashboard "deleted" banner). This matches the audit-log pattern
-- (audit_log.report_id -> reports.id is also ON DELETE SET NULL) and there
-- is no reported_user_id FK in this schema to match against.
ALTER TABLE public.reports
    ADD COLUMN IF NOT EXISTS reported_group_id uuid;

ALTER TABLE public.reports
    DROP CONSTRAINT IF EXISTS reports_reported_group_id_groups_id_fk;
ALTER TABLE public.reports
    ADD CONSTRAINT reports_reported_group_id_groups_id_fk
    FOREIGN KEY (reported_group_id) REFERENCES public.groups (id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS reports_reported_group_id_idx
    ON public.reports (reported_group_id);

-- evidence_expires_at: timestamptz NOT NULL. Backfilled as
-- created_at + 30 days for every pre-existing row, then locked
-- NOT NULL. MUST NOT end up nullable long-term.
ALTER TABLE public.reports
    ADD COLUMN IF NOT EXISTS evidence_expires_at timestamptz;

UPDATE public.reports
   SET evidence_expires_at = created_at + interval '30 days'
 WHERE evidence_expires_at IS NULL;

ALTER TABLE public.reports
    ALTER COLUMN evidence_expires_at SET NOT NULL;

-- BEFORE INSERT trigger: keeps NOT NULL enforceable for ANY insert
-- path (old app versions, raw SQL, test scripts) that does not
-- supply evidence_expires_at — it is computed as created_at + 30
-- days. Mirrors the DB-layer enforcement style already used by the
-- report_evidence cap/snapshot triggers (migration 005).
CREATE OR REPLACE FUNCTION public.tg_reports_evidence_expiry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.evidence_expires_at IS NULL THEN
        NEW.evidence_expires_at := NEW.created_at + interval '30 days';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reports_evidence_expiry ON public.reports;
CREATE TRIGGER trg_reports_evidence_expiry
    BEFORE INSERT ON public.reports
    FOR EACH ROW
    EXECUTE FUNCTION public.tg_reports_evidence_expiry();

-- ── 3. test_reports (identical mirror) ──────────────────────

ALTER TABLE IF EXISTS public.test_reports
    ADD COLUMN IF NOT EXISTS reason_category public.report_reason_category
    NOT NULL DEFAULT 'other';

ALTER TABLE IF EXISTS public.test_reports
    ADD COLUMN IF NOT EXISTS reported_group_id uuid;

ALTER TABLE IF EXISTS public.test_reports
    DROP CONSTRAINT IF EXISTS test_reports_reported_group_id_groups_id_fk;
ALTER TABLE IF EXISTS public.test_reports
    ADD CONSTRAINT test_reports_reported_group_id_groups_id_fk
    FOREIGN KEY (reported_group_id) REFERENCES public.groups (id)
    ON DELETE SET NULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relname = 'test_reports') THEN
        CREATE INDEX IF NOT EXISTS test_reports_reported_group_id_idx
            ON public.test_reports (reported_group_id);
    END IF;
END
$$;

ALTER TABLE IF EXISTS public.test_reports
    ADD COLUMN IF NOT EXISTS evidence_expires_at timestamptz;

-- Backfill + NOT NULL are table-dependent, so they are guarded the
-- same way as the index/trigger below (this UPDATE would otherwise
-- throw on a fresh environment that never created the test tables).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relname = 'test_reports') THEN
        UPDATE public.test_reports
           SET evidence_expires_at = created_at + interval '30 days'
         WHERE evidence_expires_at IS NULL;

        ALTER TABLE public.test_reports
            ALTER COLUMN evidence_expires_at SET NOT NULL;
    END IF;
END
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relname = 'test_reports') THEN
        DROP TRIGGER IF EXISTS trg_test_reports_evidence_expiry ON public.test_reports;
        CREATE TRIGGER trg_test_reports_evidence_expiry
            BEFORE INSERT ON public.test_reports
            FOR EACH ROW
            EXECUTE FUNCTION public.tg_reports_evidence_expiry();
    END IF;
END
$$;

COMMIT;

-- ============================================================
-- Verification queries (run after migration completes)
-- 1) New columns on both tables:
--    SELECT table_name, column_name, udt_name, is_nullable, column_default
--    FROM information_schema.columns
--    WHERE table_schema='public' AND table_name IN ('reports','test_reports')
--      AND column_name IN ('reason_category','reported_group_id','evidence_expires_at')
--    ORDER BY table_name, ordinal_position;
-- 2) FK + index:
--    SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid IN ('public.reports'::regclass,'public.test_reports'::regclass)
--      AND conname IN ('reports_reported_group_id_groups_id_fk',
--                      'test_reports_reported_group_id_groups_id_fk');
-- 3) Enum labels:
--    SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
--    WHERE t.typname='report_reason_category' ORDER BY e.enumsortorder;
-- ============================================================