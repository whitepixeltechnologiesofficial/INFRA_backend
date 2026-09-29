-- ============================================================================
-- verify_report_columns.sql
-- Verification for migration 015_add_report_columns.sql
-- (reports / test_reports: reason_category, reported_group_id,
--  evidence_expires_at). Run AFTER 015 has been applied.
--
-- Covers the ticket's verification steps:
--   R3.6  reports columns are present and correctly typed
--         (reason_category enum / reported_group_id uuid+FK /
--          evidence_expires_at timestamptz NOT NULL)
--   R3.6b reported_group_id FK -> groups(id) ON DELETE SET NULL exists
--   R3.6c report_reason_category has the 4 fallback enum labels
--   R3.7  test_reports is an identical mirror (same 3 columns + FK)
--   F4    a report against a GROUP (reported_group_id set,
--         reason_category set) inserts and reads back correctly —
--         the case that was previously impossible
--   F5    the FK REJECTS an insert referencing a non-existent group
--   F6    test_reports accepts the same group report (mirror parity)
--   F7    deleting the reported group does NOT delete the report —
--         reported_group_id becomes NULL (ON DELETE SET NULL)
--
-- Everything (F4–F6) runs in one transaction that is ROLLED BACK,
-- matching the existing harness style. Nothing is persisted.
--
-- NOTE: reported_phone_hash stays NOT NULL on both tables — that is
-- a pre-existing, unchanged constraint from migration DB-2.4 (the
-- report is keyed by phone_hash). A group report is expressed by
-- setting reported_group_id.
--
-- Run in: Supabase → SQL Editor → New Query → Run
-- ============================================================================

-- ── R3.6  reports: new columns typed correctly ──────────────────────────────
SELECT 'R3.6' AS check_id,
       string_agg(column_name || ':' || udt_name ||
                  CASE WHEN is_nullable='NO' THEN '!' ELSE '' END,
                  ', ' ORDER BY ordinal_position) AS detail,
       CASE WHEN count(*) FILTER (WHERE column_name='reason_category'
                                  AND udt_name='report_reason_category') = 1
             AND count(*) FILTER (WHERE column_name='reported_group_id'
                                  AND udt_name='uuid') = 1
             AND count(*) FILTER (WHERE column_name='evidence_expires_at'
                                  AND udt_name='timestamptz'
                                  AND is_nullable='NO') = 1
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM information_schema.columns
WHERE table_schema='public' AND table_name='reports'
  AND column_name IN ('reason_category','reported_group_id','evidence_expires_at');

-- ── R3.6b  reported_group_id FK -> groups(id) ON DELETE SET NULL ───────────
SELECT 'R3.6b' AS check_id,
       COALESCE((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                  WHERE conrelid='public.reports'::regclass
                    AND conname='reports_reported_group_id_groups_id_fk'), 'none') AS detail,
       CASE WHEN count(*) = 1
                 AND count(*) FILTER (WHERE confrelid='public.groups'::regclass) = 1
                 AND count(*) FILTER (WHERE pg_get_constraintdef(oid) ILIKE '%SET NULL%') = 1
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM pg_constraint
WHERE conrelid='public.reports'::regclass
  AND conname='reports_reported_group_id_groups_id_fk';

-- ── R3.6c  enum labels (ticket fallback vocabulary) ────────────────────────
SELECT 'R3.6c' AS check_id,
       string_agg(enumlabel, ',' ORDER BY enumsortorder) AS detail,
       CASE WHEN string_agg(enumlabel, ',' ORDER BY enumsortorder) =
                 'spam,harassment,inappropriate_content,other'
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
WHERE t.typname='report_reason_category';

-- ── R3.7  test_reports mirror (same columns + FK) ──────────────────────────
SELECT 'R3.7' AS check_id,
       string_agg(column_name || ':' || udt_name ||
                  CASE WHEN is_nullable='NO' THEN '!' ELSE '' END,
                  ', ' ORDER BY ordinal_position) AS detail,
       CASE WHEN count(*) FILTER (WHERE column_name='reason_category'
                                  AND udt_name='report_reason_category') = 1
             AND count(*) FILTER (WHERE column_name='reported_group_id'
                                  AND udt_name='uuid') = 1
             AND count(*) FILTER (WHERE column_name='evidence_expires_at'
                                  AND udt_name='timestamptz'
                                  AND is_nullable='NO') = 1
             AND count(*) FILTER (WHERE column_name='reported_group_id'
                                  AND is_nullable='YES') = 1
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM information_schema.columns
WHERE table_schema='public' AND table_name='test_reports'
  AND column_name IN ('reason_category','reported_group_id','evidence_expires_at');

-- ── FUNCTIONAL TESTS ────────────────────────────────────────────────────────
BEGIN;

-- F4 ── a report against a GROUP inserts + reads back correctly
DO $$
DECLARE
    v_group_id  uuid := '00000000-0000-0000-0000-00000000d601';
    v_report_id uuid := '00000000-0000-0000-0000-00000000d602';
    v_reason    text;
    v_group_read uuid;
    v_expiry    timestamptz;
    v_created   timestamptz;
BEGIN
    INSERT INTO public.groups (id, encrypted_name)
    VALUES (v_group_id, decode('cafebabe','hex'));

    INSERT INTO public.reports
        (id, reporter_phone_hash, reported_phone_hash, status,
         reason_category, reported_group_id)
    VALUES
        (v_report_id, 'vh_verify_grep', 'vh_verify_grepd', 'pending',
         'inappropriate_content', v_group_id);

    SELECT reason_category::text, reported_group_id,
           evidence_expires_at, created_at
      INTO v_reason, v_group_read, v_expiry, v_created
      FROM public.reports
     WHERE id = v_report_id;

    IF v_reason = 'inappropriate_content'
       AND v_group_read = v_group_id
       AND v_expiry IS NOT NULL
       AND v_expiry = v_created + interval '30 days' THEN
        RAISE NOTICE 'FUNC.F4 PASS: group report inserted+read back (reason=%, group=%, expiry=% = created+30d)', v_reason, v_group_read, v_expiry;
    ELSE
        RAISE NOTICE 'FUNC.F4 FAIL: reason=%, group=%, expiry=%, created=%', v_reason, v_group_read, v_expiry, v_created;
    END IF;
EXCEPTION WHEN others THEN
    RAISE NOTICE 'FUNC.F4 FAIL: % (SQLSTATE=%)', SQLERRM, SQLSTATE;
END $$;

-- F5 ── FK rejects a reported_group_id referencing no group
DO $$
BEGIN
    BEGIN
        INSERT INTO public.reports
            (reporter_phone_hash, reported_phone_hash, reason_category, reported_group_id)
        VALUES
            ('vh_verify_bad', 'vh_verify_badd', 'other',
             'ffffffff-ffff-ffff-ffff-ffffffffffff');
        RAISE NOTICE 'FUNC.F5 FAIL: FK allowed a non-existent group id';
    EXCEPTION WHEN foreign_key_violation THEN
        RAISE NOTICE 'FUNC.F5 PASS: reported_group_id FK rejected non-existent group (SQLSTATE=23503)';
    END;
END $$;

-- F6 ── test_reports mirror accepts the same group report
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relname = 'test_reports') THEN
        BEGIN
            INSERT INTO public.test_reports
                (reporter_phone_hash, reported_phone_hash, reason_category, reported_group_id)
            VALUES
                ('vh_verify_tg', 'vh_verify_tgd', 'spam',
                 '00000000-0000-0000-0000-00000000d601');
            RAISE NOTICE 'FUNC.F6 PASS: test_reports accepted a group report';
        EXCEPTION WHEN others THEN
            RAISE NOTICE 'FUNC.F6 FAIL: % (SQLSTATE=%)', SQLERRM, SQLSTATE;
        END;
    ELSE
        RAISE NOTICE 'FUNC.F6 SKIP: test_reports does not exist in this database';
    END IF;
END $$;

-- F7 ── deleting the reported group must NOT delete the report (SET NULL)
DO $$
DECLARE
    v_group_id  uuid := '00000000-0000-0000-0000-00000000d603';
    v_report_id uuid := '00000000-0000-0000-0000-00000000d604';
    v_gone      uuid;
    v_survives  boolean;
BEGIN
    INSERT INTO public.groups (id, encrypted_name)
    VALUES (v_group_id, decode('cafebabe','hex'));

    INSERT INTO public.reports
        (id, reporter_phone_hash, reported_phone_hash, status,
         reason_category, reported_group_id)
    VALUES
        (v_report_id, 'vh_verify_setnull', 'vh_verify_setnulld', 'pending',
         'other', v_group_id);

    DELETE FROM public.groups WHERE id = v_group_id;

    SELECT reported_group_id INTO v_gone FROM public.reports WHERE id = v_report_id;
    v_survives := EXISTS (SELECT 1 FROM public.reports WHERE id = v_report_id);

    IF v_survives AND v_gone IS NULL THEN
        RAISE NOTICE 'FUNC.F7 PASS: group deleted -> report survives, reported_group_id=NULL (SET NULL)';
    ELSE
        RAISE NOTICE 'FUNC.F7 FAIL: report survived=%, reported_group_id=%', v_survives, v_gone;
    END IF;
EXCEPTION WHEN others THEN
    RAISE NOTICE 'FUNC.F7 FAIL: % (SQLSTATE=%)', SQLERRM, SQLSTATE;
END $$;

ROLLBACK;

-- ============================================================================
-- END — static results appear as table rows (R3.6..R3.7);
-- functional results F4–F7 arrive as NOTICEs and are rolled back.
-- ============================================================================