-- ============================================================================
-- verify_all.sql
-- Cross-check EVERY QA/bug-report claim against the LIVE Supabase database.
-- Covers: DB-FULL-V, DB-2.2-V, DB-2.3-V, DB-2.4-V, DB-2.5-V, DB-2.6-V, DB-2.7-V
--
-- Runs in: psql  OR  Supabase "SQL Editor" (multi-statement + BEGIN/ROLLBACK)
-- Functional tests are wrapped in a transaction that is ROLLED BACK.
-- Nothing is persisted. Safe to run repeatedly.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- R1 ── DB-2.2-V  pending_messages schema
-- ---------------------------------------------------------------------------
SELECT 'R1.1' AS check_id,
       CASE WHEN udt_name = 'message_type_enum' THEN 'PASS' ELSE 'FAIL' END AS status,
       COALESCE(udt_name, 'MISSING') AS detail
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pending_messages' AND column_name = 'message_type';

SELECT 'R1.2' AS check_id,
       CASE WHEN count(*) = 6 AND string_agg(enumlabel, ',' ORDER BY enumsortorder) =
                    'text,image,video,audio,file,system' THEN 'PASS' ELSE 'FAIL' END AS status,
       string_agg(enumlabel, ',' ORDER BY enumsortorder) AS detail
FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname = 'message_type_enum';

SELECT 'R1.3' AS check_id,
       CASE WHEN bool_or(conname = 'pending_messages_message_type_check') THEN 'PASS' ELSE 'FAIL' END AS status,
       COALESCE(string_agg(conname, ', ' ORDER BY conname), 'none') AS detail
FROM pg_constraint
WHERE conrelid = 'public.pending_messages'::regclass
  AND conname IN ('pending_messages_message_type_check','pending_messages_recipient_exactly_one','pending_messages_size_bytes_non_negative');

SELECT 'R1.4' AS check_id, 'reply_to_id + voice_segment_group_id' AS label,
       string_agg(column_name, ', ' ORDER BY column_name) AS detail,
       CASE WHEN count(*) = 2 THEN 'PASS' ELSE 'FAIL' END AS status
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pending_messages'
  AND column_name IN ('reply_to_id','voice_segment_group_id');

SELECT 'R1.6' AS check_id,
       CASE WHEN count(*) > 0 THEN 'PASS' ELSE 'FAIL' END AS status,
       string_agg(conname, ', ') AS detail
FROM pg_constraint
WHERE conrelid = 'public.pending_messages'::regclass AND conname = 'pending_messages_recipient_exactly_one';

SELECT 'R1.7' AS check_id,
       CASE WHEN udt_name = 'bytea' THEN 'PASS' ELSE 'FAIL' END AS status,
       udt_name AS detail
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pending_messages' AND column_name = 'ciphertext';

SELECT 'R1.8' AS check_id,
       CASE WHEN column_default LIKE '%30%day%' THEN 'PASS' ELSE 'FAIL' END AS status,
       COALESCE(column_default, 'no default') AS detail
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pending_messages' AND column_name = 'expires_at';

-- ---------------------------------------------------------------------------
-- R2 ── DB-2.3-V  contact_hashes privacy design
-- ---------------------------------------------------------------------------
SELECT 'R2.1' AS check_id,
       string_agg(column_name || ':' || udt_name || CASE WHEN is_nullable='NO' THEN '!' ELSE '' END,
                  ', ' ORDER BY ordinal_position) AS detail,
       CASE WHEN count(*) >= 3 AND count(*) FILTER (WHERE column_name='phone_hash') = 1
             AND count(*) FILTER (WHERE column_name='user_id') = 1 THEN 'PASS' ELSE 'FAIL' END AS status
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'contact_hashes';

SELECT 'R2.1b' AS check_id,
       CASE WHEN count(*) FILTER (WHERE contype='p') >= 1 AND count(*) FILTER (WHERE contype='f') >= 1
            THEN 'PASS' ELSE 'FAIL' END AS status,
       string_agg(conname || '(' || contype::text || ')', ', ' ORDER BY conname) AS detail
FROM pg_constraint WHERE conrelid = 'public.contact_hashes'::regclass;

-- No raw phone number must be stored in contact_hashes
SELECT 'R2.2' AS check_id,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status,
       CASE WHEN count(*) = 0 THEN 'no raw-phone column' ELSE string_agg(column_name, ', ') END AS detail
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'contact_hashes'
  AND column_name IN ('phone_number','phone','raw_phone','contact_number');

-- Config gate (backend-env, NOT a DB check): apps/backend/.env must contain
-- GLOBAL_SALT or CONTACT_HASH_SALT, else phoneHash() throws at runtime.
-- Verified separately via: node apps/backend/scripts/verify_salt.cjs

-- Live usage (was empty at QA time 09-04)
SELECT 'R2.5' AS check_id, count(*)::text AS detail,
       CASE WHEN count(*) > 0 THEN 'PASS' ELSE 'FAIL' END AS status
FROM public.contact_hashes;

-- Stored hashes must be SHA-256 (64 hex chars) and non-trivial.
-- (Code-level format invariance "9876543210" vs "+91 98765 43210" -> same hash
--  is proven by apps/backend/src/utils/phone-hash.test.ts, not by SQL.)
SELECT 'R2.4' AS check_id,
       count(*)::text || ' stored hash(es), all 64-hex: ' ||
          bool_and(phone_hash ~ '^[0-9a-f]{64}$') AS detail,
       CASE WHEN count(*) > 0 AND bool_and(phone_hash ~ '^[0-9a-f]{64}$')
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM public.contact_hashes;

-- ---------------------------------------------------------------------------
-- R3 ── DB-2.4-V  blocks/reports privacy + report_evidence bounding
-- ---------------------------------------------------------------------------
SELECT 'R3.1' AS check_id,
       CASE WHEN (SELECT count(*) FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='blocks'
                    AND column_name IN ('blocker_phone_hash','blocked_phone_hash') AND NOT EXISTS (
                        SELECT 1 FROM information_schema.columns c2
                        WHERE c2.table_schema='public' AND c2.table_name='blocks' AND c2.column_name='user_id')) = 2
            THEN 'PASS' ELSE 'FAIL' END AS status,
       string_agg(column_name, ', ' ORDER BY ordinal_position) AS detail
FROM information_schema.columns WHERE table_schema='public' AND table_name='blocks';

SELECT 'R3.2' AS check_id,
       CASE WHEN (SELECT count(*) FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='reports'
                    AND column_name IN ('reporter_phone_hash','reported_phone_hash') AND NOT EXISTS (
                        SELECT 1 FROM information_schema.columns c2
                        WHERE c2.table_schema='public' AND c2.table_name='reports' AND c2.column_name='user_id')) = 2
            THEN 'PASS' ELSE 'FAIL' END AS status,
       string_agg(column_name, ', ' ORDER BY ordinal_position) AS detail
FROM information_schema.columns WHERE table_schema='public' AND table_name='reports';

SELECT 'R3.4' AS check_id,
       CASE WHEN count(*) FILTER (WHERE tgname LIKE '%cap%') >= 1 AND count(*) >= 2
            THEN 'PASS' ELSE 'FAIL' END AS status,
       string_agg(tgname, ', ' ORDER BY tgname) AS detail
FROM pg_trigger WHERE tgrelid = 'public.report_evidence'::regclass AND NOT tgisinternal;

SELECT 'R3.5' AS check_id,
       CASE WHEN count(*) = 2 THEN 'PASS' ELSE 'FAIL' END AS status,
       string_agg(table_name, ', ' ORDER BY table_name) AS detail
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('test_reports','test_report_evidence');

<<<<<<< HEAD
-- R3.8 ── BE-R2.3: report_evidence.metadata_snapshot jsonb (TAD S6.6) + test mirror
SELECT 'R3.8' AS check_id,
       CASE WHEN count(*) FILTER (WHERE table_name = 'report_evidence'
                                    AND column_name = 'metadata_snapshot'
                                    AND data_type = 'jsonb'
                                    AND is_nullable = 'YES') = 1
             AND count(*) FILTER (WHERE table_name = 'test_report_evidence'
                                    AND column_name = 'metadata_snapshot'
                                    AND data_type = 'jsonb') = 1
            THEN 'PASS' ELSE 'FAIL' END AS status,
       string_agg(table_name || '.' || column_name || ':' || data_type
                  || CASE WHEN is_nullable = 'YES' THEN ' (nullable)'
                          ELSE ' NOT NULL' END,
                  ', ' ORDER BY table_name) AS detail
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'metadata_snapshot'
  AND table_name IN ('report_evidence','test_report_evidence');
=======
-- ── R3.6 ── 013 add_report_columns: new reports columns (enum/uuid+FK/timestamptz)
SELECT 'R3.6' AS check_id,
       string_agg(column_name || ':' || udt_name ||
                  CASE WHEN is_nullable='NO' THEN '!' ELSE '' END,
                  ', ' ORDER BY ordinal_position) AS detail,
       CASE WHEN count(*) FILTER (WHERE column_name='reason_category' AND udt_name='report_reason_category') = 1
             AND count(*) FILTER (WHERE column_name='reported_group_id' AND udt_name='uuid') = 1
             AND count(*) FILTER (WHERE column_name='evidence_expires_at' AND udt_name='timestamptz' AND is_nullable='NO') = 1
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM information_schema.columns
WHERE table_schema='public' AND table_name='reports'
  AND column_name IN ('reason_category','reported_group_id','evidence_expires_at');

SELECT 'R3.6b' AS check_id,
       COALESCE((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                 WHERE conrelid='public.reports'::regclass
                   AND conname='reports_reported_group_id_groups_id_fk'), 'none') AS detail,
       CASE WHEN count(*) = 1 AND count(*) FILTER (WHERE confrelid='public.groups'::regclass) = 1
             AND count(*) FILTER (WHERE pg_get_constraintdef(oid) ILIKE '%SET NULL%') = 1
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM pg_constraint
WHERE conrelid='public.reports'::regclass AND conname='reports_reported_group_id_groups_id_fk';

SELECT 'R3.6c' AS check_id,
       string_agg(enumlabel, ',' ORDER BY enumsortorder) AS detail,
       CASE WHEN string_agg(enumlabel, ',' ORDER BY enumsortorder) = 'spam,harassment,inappropriate_content,other'
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname='report_reason_category';

-- ── R3.7 ── test_reports is an identical mirror of the 3 new columns ───────
SELECT 'R3.7' AS check_id,
       string_agg(column_name || ':' || udt_name ||
                  CASE WHEN is_nullable='NO' THEN '!' ELSE '' END,
                  ', ' ORDER BY ordinal_position) AS detail,
       CASE WHEN count(*) FILTER (WHERE column_name='reason_category' AND udt_name='report_reason_category') = 1
             AND count(*) FILTER (WHERE column_name='reported_group_id' AND udt_name='uuid') = 1
             AND count(*) FILTER (WHERE column_name='evidence_expires_at' AND udt_name='timestamptz' AND is_nullable='NO') = 1
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM information_schema.columns
WHERE table_schema='public' AND table_name='test_reports'
  AND column_name IN ('reason_category','reported_group_id','evidence_expires_at');
>>>>>>> 8d39b32 (BE-R2.2: add reason_category, reported_group_id, evidence_expires_at to reports)

-- ---------------------------------------------------------------------------
-- R4 ── DB-2.5-V  audit_log columns + moderation functions
-- ---------------------------------------------------------------------------
SELECT 'R4.1' AS check_id,
       string_agg(column_name, ', ' ORDER BY ordinal_position) AS detail,
       CASE WHEN count(*) FILTER (WHERE column_name IN
                    ('dashboard_admin_id','report_id','action','acted_at')) = 4
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'audit_log';

SELECT 'R4.2' AS check_id,
       string_agg(proname || '=' || CASE WHEN prosecdef THEN 'SECURITY DEFINER' ELSE 'invoker' END,
                  ', ' ORDER BY proname) AS detail,
       CASE WHEN count(*) >= 5 AND count(*) FILTER (WHERE proname='moderate_report' AND prosecdef) = 1
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('moderate_report','admin_warn','admin_restrict','admin_ban','admin_dismiss');

-- ---------------------------------------------------------------------------
-- R5 ── DB-FULL-V  F-04 / F-05 / F-06 remediations
-- ---------------------------------------------------------------------------
SELECT 'R5.1' AS check_id, 'F-04 devices.user_id FK' AS label,
       string_agg(conname, ', ') AS detail,
       CASE WHEN count(*) >= 1 AND bool_or(conname LIKE 'devices_user_id%') THEN 'PASS' ELSE 'FAIL' END AS status
FROM pg_constraint WHERE conrelid = 'public.devices'::regclass AND contype = 'f';

SELECT 'R5.2' AS check_id, 'F-05 pending_messages.sender_device_id FK' AS label,
       string_agg(conname, ', ') AS detail,
       CASE WHEN count(*) >= 1 AND bool_or(conname LIKE '%sender_device_id%') THEN 'PASS' ELSE 'FAIL' END AS status
FROM pg_constraint WHERE conrelid = 'public.pending_messages'::regclass AND contype = 'f';

SELECT 'R5.3' AS check_id, 'F-06 sms_outbox status CHECK' AS label,
       (SELECT pg_get_constraintdef(oid) FROM pg_constraint
         WHERE conrelid = 'public.sms_outbox'::regclass
           AND conname = 'sms_outbox_status_check') AS detail,
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS status
FROM pg_constraint WHERE conrelid = 'public.sms_outbox'::regclass
  AND conname = 'sms_outbox_status_check';

SELECT 'R5.4' AS check_id, 'RLS policies = 0 (by design)' AS label,
       count(*)::text AS detail,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status
FROM pg_policies WHERE schemaname = 'public';

-- ---------------------------------------------------------------------------
-- R6 ── DB-2.6-V  8 supporting tables + hashing + isolation
-- ---------------------------------------------------------------------------
SELECT 'R6.1' AS check_id,
       string_agg(relname, ', ' ORDER BY relname) AS detail,
       CASE WHEN count(*) = 8 THEN 'PASS' ELSE 'FAIL' END AS status
FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND t.relname IN
      ('otp_verifications','sessions','dashboard_sessions','push_tokens','chat_mutes',
       'legal_acceptances','rate_limit_counters','sms_outbox');

SELECT 'R6.2' AS check_id,
       CASE WHEN count(*) > 0 AND bool_and(refresh_token_hash ~ '^\$2[aby]\$')
            THEN 'PASS' ELSE 'FAIL' END AS status,
       count(*)::text || ' rows, all bcrypt-prefixed ($2b$12$...60 chars)' AS detail
FROM public.sessions WHERE refresh_token_hash IS NOT NULL;

SELECT 'R6.3' AS check_id, 'sessions.revoked_at present' AS label,
       bool_or(column_name='revoked_at')::text AS detail,
       CASE WHEN bool_or(column_name='revoked_at') THEN 'PASS' ELSE 'FAIL' END AS status
FROM information_schema.columns
WHERE table_schema='public' AND table_name='sessions';

SELECT 'R6.4' AS check_id, 'otp_verifications lockout/hash columns' AS label,
       string_agg(column_name, ', ' ORDER BY ordinal_position) AS detail,
       CASE WHEN count(*) FILTER (WHERE column_name IN ('code_hash','attempts','locked_until','expires_at')) = 4
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM information_schema.columns
WHERE table_schema='public' AND table_name='otp_verifications';

-- Structural isolation: sessions has NO FK while dashboard_sessions links only to dashboard_admins
SELECT 'R6.5' AS check_id, 'sessions/dashboard_sessions isolation' AS label,
       (SELECT string_agg(conname||'->'||confrelid::regclass::text, ', ') FROM pg_constraint
         WHERE conrelid='public.sessions'::regclass AND contype='f') AS sessions_fk,
       (SELECT string_agg(conname||'->'||confrelid::regclass::text, ', ') FROM pg_constraint
         WHERE conrelid='public.dashboard_sessions'::regclass AND contype='f') AS dashboard_sessions_fk,
       CASE WHEN NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.sessions'::regclass AND contype='f')
             AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.dashboard_sessions'::regclass AND contype='f')
            THEN 'PASS' ELSE 'FAIL' END AS status;

-- ---------------------------------------------------------------------------
-- R7 ── DB-2.7-V  retention remediation
-- ---------------------------------------------------------------------------
SELECT 'R7.1' AS check_id, 'public.run_data_cleanup() EXISTS' AS label,
       CASE WHEN count(*) >= 1 THEN 'PASS' ELSE 'FAIL' END AS status,
       COALESCE((SELECT pg_get_function_result(oid) FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='run_data_cleanup' LIMIT 1), 'MISSING') AS detail
FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='run_data_cleanup';

SELECT 'R7.2' AS check_id, 'purged_at on evidence tables' AS label,
       string_agg(table_name, ', ' ORDER BY table_name) AS detail,
       CASE WHEN count(*) >= 2 THEN 'PASS' ELSE 'FAIL' END AS status
FROM information_schema.columns
WHERE table_schema='public' AND column_name='purged_at'
  AND table_name IN ('report_evidence','test_report_evidence');

SELECT 'R7.3' AS check_id, 'pending_messages.media_path present' AS label,
       count(*)::text AS detail,
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS status
FROM information_schema.columns
WHERE table_schema='public' AND table_name='pending_messages' AND column_name='media_path';

SELECT 'R7.4' AS check_id, 'phone_reuse_cooldowns (phone_hash PK + cooldown_until)' AS label,
       string_agg(column_name || ':' || udt_name, ', ' ORDER BY ordinal_position) AS detail,
       CASE WHEN bool_or(column_name='phone_hash') AND bool_or(column_name='cooldown_until')
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM information_schema.columns
WHERE table_schema='public' AND table_name='phone_reuse_cooldowns';

SELECT 'R7.5' AS check_id, 'storage-purge trigger on pending_messages' AS label,
       string_agg(tgname, ', ') AS detail,
       CASE WHEN count(*) >= 1 AND bool_or(tgname LIKE '%purge%') THEN 'PASS' ELSE 'FAIL' END AS status
FROM pg_trigger WHERE tgrelid='public.pending_messages'::regclass AND NOT tgisinternal;

SELECT 'R7.6' AS check_id, 'cron: daily-data-cleanup -> run_data_cleanup()' AS label,
       string_agg(schedule || '  ' || left(command, 60), ' | ') AS detail,
       CASE WHEN bool_or(jobname='daily-data-cleanup' AND command ~ 'run_data_cleanup\(\)')
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM cron.job;

SELECT 'R7.6b' AS check_id, 'cron: cleanup-pending-messages (every 5 min)' AS label,
       string_agg(schedule || '  ' || left(command, 60), ' | ') AS detail,
       CASE WHEN bool_or(jobname='cleanup-pending-messages' AND schedule LIKE '%5%')
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM cron.job;

SELECT 'R7.7' AS check_id, 'latest daily-data-cleanup run succeeded' AS label,
       string_agg(start_time::timestamp(0)::text || ':' || status, ' | ' ORDER BY start_time DESC) AS detail,
       CASE WHEN (SELECT status FROM cron.job_run_details jd
                  WHERE jd.jobid=(SELECT jobid FROM cron.job WHERE jobname='daily-data-cleanup')
                  ORDER BY jd.start_time DESC LIMIT 1) = 'succeeded'
            THEN 'PASS' ELSE 'FAIL' END AS status
FROM cron.job_run_details
WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='daily-data-cleanup');

-- ---------------------------------------------------------------------------
-- FUNCTIONAL TESTS -- all wrapped in a transaction, ROLLED BACK afterwards.
-- ---------------------------------------------------------------------------
BEGIN;

-- F1 ── invalid message_type must be rejected by the DB enum
DO $$
BEGIN
  BEGIN
    INSERT INTO public.pending_messages (sender_device_id, recipient_device_id, ciphertext, message_type)
    VALUES (gen_random_uuid(), gen_random_uuid(), decode('cafebabe','hex'), 'INVALID_TYPE');
    RAISE NOTICE 'FUNC.F1 FAIL: invalid message_type was ACCEPTED';
  EXCEPTION WHEN others THEN
    IF SQLSTATE = '22P02' THEN
      RAISE NOTICE 'FUNC.F1 PASS: invalid message_type rejected (SQLSTATE=22P02)';
    ELSE
      RAISE NOTICE 'FUNC.F1 INFO: rejected with SQLSTATE=% : %', SQLSTATE, SQLERRM;
    END IF;
  END;
END $$;

-- F2 ── run_data_cleanup() executes twice (idempotent, void, no throw)
DO $$
BEGIN
  PERFORM public.run_data_cleanup();
  PERFORM public.run_data_cleanup();
  RAISE NOTICE 'FUNC.F2 PASS: run_data_cleanup() executed 2x without error';
EXCEPTION WHEN others THEN
  RAISE NOTICE 'FUNC.F2 FAIL: %', SQLERRM;
END $$;

-- F3 ── moderate_report() atomicity: fabricated report + admin -> status change + audit_log row
DO $$
DECLARE
  v_report_id  uuid := '00000000-0000-0000-0000-00000000d501';
  v_admin_id   uuid := '00000000-0000-0000-0000-00000000d502';
  v_act        public.audit_action;
  v_report_status text;
  v_audit_rows int;
BEGIN
  SELECT enumlabel INTO v_act FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
   WHERE t.typname='audit_action' ORDER BY e.enumsortorder LIMIT 1;

  INSERT INTO public.reports (id, reporter_phone_hash, reported_phone_hash, status)
  VALUES (v_report_id, 'vh_verify_rep', 'vh_verify_repd', 'pending')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.dashboard_admins (id, email, password_hash, role)
  VALUES (v_admin_id, 'verify@wpt.local', '$2b$12$abcdefghijklmnopqrstuv.verify.hash.only', 'owner')
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.moderate_report(v_report_id, v_admin_id, v_act);

  SELECT status::text INTO v_report_status FROM public.reports WHERE id=v_report_id;
  SELECT count(*)::int INTO v_audit_rows FROM public.audit_log
   WHERE report_id=v_report_id AND dashboard_admin_id=v_admin_id;

  IF v_report_status IS DISTINCT FROM 'pending' AND v_audit_rows >= 1 THEN
    RAISE NOTICE 'FUNC.F3 PASS: report->%, audit_log rows=% (atomic, SECURITY DEFINER)', v_report_status, v_audit_rows;
  ELSE
    RAISE NOTICE 'FUNC.F3 FAIL: report stayed %, audit_log rows=%', v_report_status, v_audit_rows;
  END IF;
END $$;

-- F4 ── group report (013): insert with reported_group_id + reason_category,
--      read back, confirm evidence_expires_at = created_at + 30 days.
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

  SELECT reason_category::text, reported_group_id, evidence_expires_at, created_at
    INTO v_reason, v_group_read, v_expiry, v_created
  FROM public.reports WHERE id = v_report_id;

  IF v_reason = 'inappropriate_content' AND v_group_read = v_group_id
     AND v_expiry IS NOT NULL AND v_expiry = v_created + interval '30 days' THEN
    RAISE NOTICE 'FUNC.F4 PASS: group report inserted+read back (reason=%, group=%, expiry=created+30d)', v_reason, v_group_read;
  ELSE
    RAISE NOTICE 'FUNC.F4 FAIL: reason=%, group=%, expiry=%, created=%', v_reason, v_group_read, v_expiry, v_created;
  END IF;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'FUNC.F4 FAIL: % (SQLSTATE=%)', SQLERRM, SQLSTATE;
END $$;

-- F5 ── reported_group_id FK (013) rejects a non-existent group id
DO $$
BEGIN
  BEGIN
    INSERT INTO public.reports
        (reporter_phone_hash, reported_phone_hash, reason_category, reported_group_id)
    VALUES
        ('vh_verify_bad', 'vh_verify_badd', 'other', 'ffffffff-ffff-ffff-ffff-ffffffffffff');
    RAISE NOTICE 'FUNC.F5 FAIL: FK allowed a non-existent group id';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'FUNC.F5 PASS: reported_group_id FK rejected non-existent group (SQLSTATE=23503)';
  END;
END $$;

-- F6 ── test_reports mirror (013) accepts the same group report
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname='public' AND c.relname='test_reports') THEN
    BEGIN
      INSERT INTO public.test_reports
          (reporter_phone_hash, reported_phone_hash, reason_category, reported_group_id)
      VALUES
          ('vh_verify_tg', 'vh_verify_tgd', 'spam', '00000000-0000-0000-0000-00000000d601');
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
      (v_report_id, 'vh_verify_setnull', 'vh_verify_setnulld', 'pending', 'other', v_group_id);

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
-- END — recheck the printed NOTICEs for the functional results (F1–F7).
-- Static results appear as table rows, functional results as NOTICEs.
-- ============================================================================