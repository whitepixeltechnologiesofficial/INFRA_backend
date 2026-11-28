BEGIN;

CREATE SCHEMA IF NOT EXISTS test;

DO $$
BEGIN
    IF to_regclass('public.test_reports') IS NOT NULL
       AND to_regclass('test.test_reports') IS NULL THEN
        ALTER TABLE public.test_reports SET SCHEMA test;
    END IF;
END
$$;

DO $$
BEGIN
    IF to_regclass('public.test_report_evidence') IS NOT NULL
       AND to_regclass('test.test_report_evidence') IS NULL THEN
        ALTER TABLE public.test_report_evidence SET SCHEMA test;
    END IF;
END
$$;

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
    FROM test.test_report_evidence
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

CREATE OR REPLACE FUNCTION public.tg_backfill_test_report_snapshots()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_report uuid;
    v_since  timestamptz := now() - interval '7 days';
    v_snapshot jsonb;
BEGIN
    FOR v_report IN
        SELECT DISTINCT test_report_id FROM test.test_report_evidence
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
            FROM test.test_report_evidence re
            WHERE re.test_report_id = v_report
              AND (re.message_created_at IS NULL OR re.message_created_at >= v_since)
            ORDER BY COALESCE(re.message_created_at, re.captured_at) DESC
            LIMIT 20
        ) m;

        UPDATE test.test_reports
        SET decrypted_message_snapshot = v_snapshot
        WHERE id = v_report;

        UPDATE test.test_report_evidence
        SET decrypted_message_snapshot = v_snapshot
        WHERE test_report_id = v_report;
    END LOOP;

    RETURN NULL;
END;
$$;

COMMIT;
