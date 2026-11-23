-- ============================================================
-- 020_db24_blocks_reports_test_tables.sql
-- DB-2.4 — blocks, reports, report_evidence (+ test mirrors).
-- Tech Arch §6.6.
--
-- WHY THIS MIGRATION EXISTS
--   The Sprint 1–3 status report marked DB-2.4 "Partial":
--   blocks / reports / report_evidence work on main, but
--   test_reports and test_report_evidence were never created by any
--   migration in this repo (005/009/014/015/016 only ALTER them, and
--   015 says they were "created out-of-band"). This file is the
--   single canonical CREATE for all five DB-2.4 tables.
--
-- KEY DESIGN CHOICE
--   Everything is keyed by phone_hash, NOT user_id. phone_hash is
--   derived from the number, so it survives account deletion: a
--   user who deletes and re-creates their account on the same
--   number keeps their block/report history with no extra code.
--   That is why there is NO foreign key to users here.
--
-- BIDIRECTIONAL BLOCKS
--   One row (blocker -> blocked) blocks messaging in BOTH directions.
--   Enforced in the app layer by hasBlockBetween() in
--   src/routes/relay.ts, which checks (A,B) OR (B,A). The reverse
--   index below keeps the (B,A) half of that lookup indexed.
--
-- EVIDENCE BOUND (privacy-minimizing)
--   report_evidence holds at most the SMALLER of:
--     the last 20 messages  OR  all messages from the last 7 days.
--   Both limits apply at once (row #21 is rejected; a message older
--   than 7 days is rejected), so the stored set is always the
--   intersection = the smaller of the two. Enforced by the
--   BEFORE INSERT cap triggers from migration 005, re-attached here
--   for the test tables.
--
-- TEST MIRRORS
--   test_reports / test_report_evidence have the same columns,
--   enums, defaults, checks and triggers as the real tables. The
--   admin dashboard writes to them for test accounts so test actions
--   never touch real user reports. The only naming difference is
--   test_report_evidence.test_report_id (the name migration 005 and
--   the test triggers already use).
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE throughout. On the
-- live DB this only creates the two missing test tables + triggers;
-- the real tables are left untouched.
--
-- Run this in: Supabase → SQL Editor → New Query → Run
-- Then run scripts/verify-db24.sql.
-- ============================================================

BEGIN;

-- ── Enums ───────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_status') THEN
        CREATE TYPE public.report_status AS ENUM
            ('pending', 'reviewed', 'actioned', 'dismissed');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_reason_category') THEN
        CREATE TYPE public.report_reason_category AS ENUM
            ('spam', 'harassment', 'inappropriate_content', 'other');
    END IF;
END
$$;

-- ── 1. blocks ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.blocks (
    blocker_phone_hash text        NOT NULL,
    blocked_phone_hash text        NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT blocks_blocker_phone_hash_blocked_phone_hash_pk
        PRIMARY KEY (blocker_phone_hash, blocked_phone_hash)
);

-- A user cannot block themselves (the API already rejects this;
-- this makes it a DB guarantee).
DO $$
BEGIN
    ALTER TABLE public.blocks
        ADD CONSTRAINT blocks_not_self_chk
        CHECK (blocker_phone_hash <> blocked_phone_hash) NOT VALID;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

-- The PK covers lookups by blocker; this covers the reverse half of
-- the bidirectional check (WHERE blocked_phone_hash = $me).
CREATE INDEX IF NOT EXISTS blocks_blocked_phone_hash_idx
    ON public.blocks (blocked_phone_hash);

-- ── 2. reports ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reports (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_phone_hash        text NOT NULL,
    reported_phone_hash        text NOT NULL,
    reported_group_id          uuid
        CONSTRAINT reports_reported_group_id_groups_id_fk
        REFERENCES public.groups (id) ON DELETE SET NULL,
    reason_category            public.report_reason_category NOT NULL DEFAULT 'other',
    status                     public.report_status NOT NULL DEFAULT 'pending',
    created_at                 timestamptz NOT NULL DEFAULT now(),
    evidence_expires_at        timestamptz NOT NULL,
    reviewed_at                timestamptz,
    actioned_at                timestamptz,
    decrypted_message_snapshot jsonb
);

CREATE INDEX IF NOT EXISTS reports_reporter_phone_hash_idx ON public.reports (reporter_phone_hash);
CREATE INDEX IF NOT EXISTS reports_reported_phone_hash_idx ON public.reports (reported_phone_hash);
CREATE INDEX IF NOT EXISTS reports_status_idx              ON public.reports (status);
CREATE INDEX IF NOT EXISTS reports_reported_group_id_idx   ON public.reports (reported_group_id);

-- ── 3. report_evidence ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.report_evidence (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id                  uuid NOT NULL
        REFERENCES public.reports (id) ON DELETE CASCADE,
    message_content            text,
    message_created_at         timestamptz NOT NULL,
    captured_at                timestamptz NOT NULL DEFAULT now(),
    decrypted_message_snapshot jsonb,
    metadata_snapshot          jsonb,
    media_bucket               text,
    media_path                 text,
    purged_at                  timestamptz,
    CONSTRAINT report_evidence_media_pair_chk
        CHECK ((media_bucket IS NULL) = (media_path IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_report_evidence_report_id ON public.report_evidence (report_id);
CREATE INDEX IF NOT EXISTS idx_report_evidence_purged    ON public.report_evidence (purged_at);
CREATE INDEX IF NOT EXISTS idx_report_evidence_media_pending
    ON public.report_evidence (captured_at) WHERE media_path IS NOT NULL;

-- ── 4. test_reports (mirror of reports) ─────────────────────
CREATE TABLE IF NOT EXISTS public.test_reports (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_phone_hash        text NOT NULL,
    reported_phone_hash        text NOT NULL,
    reported_group_id          uuid
        CONSTRAINT test_reports_reported_group_id_groups_id_fk
        REFERENCES public.groups (id) ON DELETE SET NULL,
    reason_category            public.report_reason_category NOT NULL DEFAULT 'other',
    status                     public.report_status NOT NULL DEFAULT 'pending',
    created_at                 timestamptz NOT NULL DEFAULT now(),
    evidence_expires_at        timestamptz NOT NULL,
    reviewed_at                timestamptz,
    actioned_at                timestamptz,
    decrypted_message_snapshot jsonb
);

CREATE INDEX IF NOT EXISTS test_reports_reporter_phone_hash_idx ON public.test_reports (reporter_phone_hash);
CREATE INDEX IF NOT EXISTS test_reports_reported_phone_hash_idx ON public.test_reports (reported_phone_hash);
CREATE INDEX IF NOT EXISTS test_reports_status_idx              ON public.test_reports (status);
CREATE INDEX IF NOT EXISTS test_reports_reported_group_id_idx   ON public.test_reports (reported_group_id);

-- ── 5. test_report_evidence (mirror of report_evidence) ─────
CREATE TABLE IF NOT EXISTS public.test_report_evidence (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    test_report_id             uuid NOT NULL
        REFERENCES public.test_reports (id) ON DELETE CASCADE,
    message_content            text,
    message_created_at         timestamptz NOT NULL,
    captured_at                timestamptz NOT NULL DEFAULT now(),
    decrypted_message_snapshot jsonb,
    metadata_snapshot          jsonb,
    media_bucket               text,
    media_path                 text,
    purged_at                  timestamptz,
    CONSTRAINT test_report_evidence_media_pair_chk
        CHECK ((media_bucket IS NULL) = (media_path IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_test_report_evidence_report_id
    ON public.test_report_evidence (test_report_id);
CREATE INDEX IF NOT EXISTS idx_test_report_evidence_purged
    ON public.test_report_evidence (purged_at);
CREATE INDEX IF NOT EXISTS idx_test_report_evidence_media_pending
    ON public.test_report_evidence (captured_at) WHERE media_path IS NOT NULL;

-- ── 6. Triggers ─────────────────────────────────────────────

-- evidence_expires_at = created_at + 30 days when not supplied
-- (same function as migration 015; shared by both report tables).
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
    FOR EACH ROW EXECUTE FUNCTION public.tg_reports_evidence_expiry();

DROP TRIGGER IF EXISTS trg_test_reports_evidence_expiry ON public.test_reports;
CREATE TRIGGER trg_test_reports_evidence_expiry
    BEFORE INSERT ON public.test_reports
    FOR EACH ROW EXECUTE FUNCTION public.tg_reports_evidence_expiry();

-- Real report_evidence cap/snapshot triggers are owned by migration
-- 005 and already live; only attach them here on a fresh DB where
-- 005's functions exist but the triggers do not.
DO $$
BEGIN
    IF to_regproc('public.tg_report_evidence_cap') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_trigger
                       WHERE tgname = 'trg_report_evidence_cap'
                         AND tgrelid = 'public.report_evidence'::regclass) THEN
        CREATE TRIGGER trg_report_evidence_cap
            BEFORE INSERT ON public.report_evidence
            FOR EACH ROW EXECUTE FUNCTION public.tg_report_evidence_cap();
    END IF;
    IF to_regproc('public.tg_backfill_report_snapshots') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_trigger
                       WHERE tgname = 'trg_backfill_report_snapshots'
                         AND tgrelid = 'public.report_evidence'::regclass) THEN
        CREATE TRIGGER trg_backfill_report_snapshots
            AFTER INSERT OR DELETE ON public.report_evidence
            FOR EACH STATEMENT EXECUTE FUNCTION public.tg_backfill_report_snapshots();
    END IF;
END
$$;

-- Test evidence cap: max 20 rows per test report AND each message
-- within the last 7 days → stored set is the smaller of the two.
-- (Same body as migration 005.)
CREATE OR REPLACE FUNCTION public.tg_test_report_evidence_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_report uuid := NEW.test_report_id;
    v_count  integer;
    v_since  timestamptz := now() - interval '7 days';
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM public.test_report_evidence
    WHERE test_report_id = v_report;

    IF v_count >= 20 THEN
        RAISE EXCEPTION 'report evidence cap reached: % messages for report %', 20, v_report
            USING ERRCODE = 'P0001';
    END IF;

    IF NEW.message_created_at IS NOT NULL
       AND NEW.message_created_at < v_since THEN
        RAISE EXCEPTION 'evidence message is outside the 7-day bounding window'
            USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_test_report_evidence_cap ON public.test_report_evidence;
CREATE TRIGGER trg_test_report_evidence_cap
    BEFORE INSERT ON public.test_report_evidence
    FOR EACH ROW EXECUTE FUNCTION public.tg_test_report_evidence_cap();

-- Rebuild the bounded jsonb snapshot on the test report and its
-- evidence rows after any insert/delete. (Same body as migration 005.)
CREATE OR REPLACE FUNCTION public.tg_backfill_test_report_snapshots()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_report   uuid;
    v_since    timestamptz := now() - interval '7 days';
    v_snapshot jsonb;
BEGIN
    FOR v_report IN
        SELECT DISTINCT test_report_id FROM public.test_report_evidence
    LOOP
        SELECT COALESCE(
            jsonb_agg(jsonb_build_object(
                'message_content',    m.message_content,
                'message_created_at', m.message_created_at,
                'captured_at',        m.captured_at
            ) ORDER BY COALESCE(m.message_created_at, m.captured_at) DESC),
            '[]'::jsonb
        )
        INTO v_snapshot
        FROM (
            SELECT re.*
            FROM public.test_report_evidence re
            WHERE re.test_report_id = v_report
              AND (re.message_created_at IS NULL OR re.message_created_at >= v_since)
            ORDER BY COALESCE(re.message_created_at, re.captured_at) DESC
            LIMIT 20
        ) m;

        UPDATE public.test_reports
        SET decrypted_message_snapshot = v_snapshot
        WHERE id = v_report;

        UPDATE public.test_report_evidence
        SET decrypted_message_snapshot = v_snapshot
        WHERE test_report_id = v_report;
    END LOOP;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_backfill_test_report_snapshots ON public.test_report_evidence;
CREATE TRIGGER trg_backfill_test_report_snapshots
    AFTER INSERT OR DELETE ON public.test_report_evidence
    FOR EACH STATEMENT EXECUTE FUNCTION public.tg_backfill_test_report_snapshots();

COMMIT;

-- ============================================================
-- Verification: run scripts/verify-db24.sql (rolls back, writes
-- nothing). Quick check that all five tables now exist:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--     AND table_name IN ('blocks','reports','report_evidence',
--                        'test_reports','test_report_evidence');
-- ============================================================
