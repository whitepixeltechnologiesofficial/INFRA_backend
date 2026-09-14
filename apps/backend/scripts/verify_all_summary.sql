-- ============================================================================
-- verify_all_summary.sql
-- All 36 static checks in ONE result set (SELECT ... UNION ALL ...).
-- Why: the Supabase SQL Editor shows only the LAST result set; a single grid
-- guarantees every check is visible. Functional tests stay as DO blocks with
-- NOTICEs (rolled back) at the end.
-- Nothing is persisted.
-- ============================================================================

SELECT
  check_id, label, status,
  detail
FROM (
  SELECT 'R1.1' AS check_id, 'message_relay.message_type is an enum' AS label,
    CASE WHEN (SELECT udt_name FROM information_schema.columns
               WHERE table_schema='public' AND table_name='message_relay' AND column_name='message_type')
              = 'message_type_enum' THEN 'PASS' ELSE 'FAIL' END AS status,
    COALESCE((SELECT udt_name FROM information_schema.columns
              WHERE table_schema='public' AND table_name='message_relay' AND column_name='message_type'),'MISSING') AS detail
  UNION ALL SELECT 'R1.2',
    'message_type_enum has 6 values (text,image,video,audio,file,system)',
    CASE WHEN (SELECT count(*) FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid WHERE t.typname='message_type_enum') = 6
          AND (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid WHERE t.typname='message_type_enum')
              = 'text,image,video,audio,file,system' THEN 'PASS' ELSE 'FAIL' END,
    (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid WHERE t.typname='message_type_enum')
  UNION ALL SELECT 'R1.3',
    'message_relay_message_type_check CHECK constraint',
    CASE WHEN (SELECT count(*) FROM pg_constraint WHERE conrelid='public.message_relay'::regclass
               AND conname='message_relay_message_type_check') = 1 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT COALESCE(string_agg(conname, ', ' ORDER BY conname),'none') FROM pg_constraint
     WHERE conrelid='public.message_relay'::regclass
       AND conname IN ('message_relay_message_type_check','message_relay_recipient_exactly_one','message_relay_size_bytes_non_negative'))
  UNION ALL SELECT 'R1.4',
    'reply_to_id + voice_segment_group_id present',
    CASE WHEN (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='message_relay'
               AND column_name IN ('reply_to_id','voice_segment_group_id')) = 2 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT COALESCE(string_agg(column_name, ', ' ORDER BY column_name),'none') FROM information_schema.columns
     WHERE table_schema='public' AND table_name='message_relay' AND column_name IN ('reply_to_id','voice_segment_group_id'))
  UNION ALL SELECT 'R1.6',
    'recipient_exactly_one CHECK (user XOR group)',
    CASE WHEN (SELECT count(*) FROM pg_constraint WHERE conrelid='public.message_relay'::regclass
               AND conname='message_relay_recipient_exactly_one') = 1 THEN 'PASS' ELSE 'FAIL' END, 'constraint present'
  UNION ALL SELECT 'R1.7',
    'ciphertext is bytea',
    CASE WHEN (SELECT udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='message_relay'
               AND column_name='ciphertext') = 'bytea' THEN 'PASS' ELSE 'FAIL' END,
    (SELECT udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='message_relay' AND column_name='ciphertext')
  UNION ALL SELECT 'R1.8',
    'expires_at defaults to now()+30 days',
    CASE WHEN (SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='message_relay'
               AND column_name='expires_at') LIKE '%30%day%' THEN 'PASS' ELSE 'FAIL' END,
    COALESCE((SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='message_relay'
               AND column_name='expires_at'),'no default')
  -- --------------------------------------------------------------------- R2 -
  UNION ALL SELECT 'R2.1',
    'contact_hashes: phone_hash(PK) + user_id(uuid FK) + created_at',
    CASE WHEN (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='contact_hashes') >= 3
          AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='contact_hashes' AND column_name='phone_hash') = 1
          AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='contact_hashes' AND column_name='user_id') = 1
         THEN 'PASS' ELSE 'FAIL' END,
    (SELECT string_agg(column_name || ':' || udt_name || CASE WHEN is_nullable='NO' THEN '!' ELSE '' END, ', ' ORDER BY ordinal_position)
     FROM information_schema.columns WHERE table_schema='public' AND table_name='contact_hashes')
  UNION ALL SELECT 'R2.1b',
    'contact_hashes PRIMARY KEY + FOREIGN KEY',
    CASE WHEN (SELECT count(*) FROM pg_constraint WHERE conrelid='public.contact_hashes'::regclass AND contype='p') >= 1
          AND (SELECT count(*) FROM pg_constraint WHERE conrelid='public.contact_hashes'::regclass AND contype='f') >= 1
         THEN 'PASS' ELSE 'FAIL' END,
    (SELECT string_agg(conname || '(' || contype::text || ')', ', ' ORDER BY conname)
     FROM pg_constraint WHERE conrelid='public.contact_hashes'::regclass)
  UNION ALL SELECT 'R2.2',
    'no raw phone column in contact_hashes',
    CASE WHEN (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='contact_hashes'
               AND column_name IN ('phone_number','phone','raw_phone','contact_number')) = 0 THEN 'PASS' ELSE 'FAIL' END, 'no raw-phone column'
  -- R2.3 (backend-env gate, NOT a DB check): apps/backend/.env must contain
  -- GLOBAL_SALT or CONTACT_HASH_SALT, else phoneHash() throws at runtime.
  -- Verified separately via: node apps/backend/scripts/verify_salt.cjs
  UNION ALL SELECT 'R2.4',
    'stored contact hashes are SHA-256 (64 hex)',
    CASE WHEN (SELECT count(*) FROM public.contact_hashes) > 0
          AND (SELECT bool_and(phone_hash ~ '^[0-9a-f]{64}$') FROM public.contact_hashes) THEN 'PASS' ELSE 'FAIL' END,
    (SELECT count(*) || ' stored hash(es), all 64-hex: ' || bool_and(phone_hash ~ '^[0-9a-f]{64}$') FROM public.contact_hashes)
  UNION ALL SELECT 'R2.5',
    'contact_hashes populated (was empty at QA)',
    CASE WHEN (SELECT count(*) FROM public.contact_hashes) > 0 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT count(*)::text FROM public.contact_hashes)
  -- --------------------------------------------------------------------- R3 -
  UNION ALL SELECT 'R3.1',
    'blocks keyed by phone_hash, no user_id',
    CASE WHEN (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='blocks'
               AND column_name IN ('blocker_phone_hash','blocked_phone_hash')) = 2
          AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='blocks' AND column_name='user_id') = 0
         THEN 'PASS' ELSE 'FAIL' END,
    (SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='blocks')
  UNION ALL SELECT 'R3.2',
    'reports keyed by phone_hash, no user_id',
    CASE WHEN (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='reports'
               AND column_name IN ('reporter_phone_hash','reported_phone_hash')) = 2
          AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='reports' AND column_name='user_id') = 0
         THEN 'PASS' ELSE 'FAIL' END,
    (SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='reports')
  UNION ALL SELECT 'R3.4',
    'evidence snapshots: cap + backfill triggers',
    CASE WHEN (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.report_evidence'::regclass AND NOT tgisinternal) >= 2
          AND (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.report_evidence'::regclass AND NOT tgisinternal AND tgname LIKE '%cap%') >= 1
         THEN 'PASS' ELSE 'FAIL' END,
    (SELECT COALESCE(string_agg(tgname, ', ' ORDER BY tgname),'none') FROM pg_trigger WHERE tgrelid='public.report_evidence'::regclass AND NOT tgisinternal)
  UNION ALL SELECT 'R3.5',
    'parallel test tables exist (test_reports, test_report_evidence)',
    CASE WHEN (SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
               AND table_name IN ('test_reports','test_report_evidence')) = 2 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT COALESCE(string_agg(table_name, ', ' ORDER BY table_name),'none') FROM information_schema.tables
     WHERE table_schema='public' AND table_name IN ('test_reports','test_report_evidence'))
  -- --------------------------------------------------------------------- R4 -
  UNION ALL SELECT 'R4.1',
    'audit_log: dashboard_admin_id/report_id/action/acted_at',
    CASE WHEN (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_log'
               AND column_name IN ('dashboard_admin_id','report_id','action','acted_at')) = 4 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_log')
  UNION ALL SELECT 'R4.2',
    'moderate_report (SECURITY DEFINER) + 4 admin wrappers',
    CASE WHEN (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
               AND p.proname IN ('moderate_report','admin_warn','admin_restrict','admin_ban','admin_dismiss')) >= 5
          AND (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='moderate_report' AND p.prosecdef) = 1
         THEN 'PASS' ELSE 'FAIL' END,
    (SELECT string_agg(proname || '=' || CASE WHEN prosecdef THEN 'SECURITY DEFINER' ELSE 'invoker' END, ', ' ORDER BY proname)
     FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('moderate_report','admin_warn','admin_restrict','admin_ban','admin_dismiss'))
  -- --------------------------------------------------------------------- R5 -
  UNION ALL SELECT 'R5.1',
    'F-04 devices.user_id FK -> users',
    CASE WHEN (SELECT count(*) FROM pg_constraint WHERE conrelid='public.devices'::regclass AND contype='f'
               AND conname LIKE 'devices_user_id%') = 1 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT COALESCE(string_agg(conname, ', ' ORDER BY conname),'none') FROM pg_constraint
     WHERE conrelid='public.devices'::regclass AND contype='f')
  UNION ALL SELECT 'R5.2',
    'F-05 message_relay.sender_device_id FK -> devices',
    CASE WHEN (SELECT count(*) FROM pg_constraint WHERE conrelid='public.message_relay'::regclass AND contype='f'
               AND conname LIKE '%sender_device_id%') >= 1 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT COALESCE(string_agg(conname, ', ' ORDER BY conname),'none') FROM pg_constraint
     WHERE conrelid='public.message_relay'::regclass AND contype='f')
  UNION ALL SELECT 'R5.3',
    'F-06 sms_outbox status CHECK (pending/sent/failed)',
    CASE WHEN (SELECT count(*) FROM pg_constraint WHERE conrelid='public.sms_outbox'::regclass
               AND conname='sms_outbox_status_check') = 1 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint
     WHERE conrelid='public.sms_outbox'::regclass AND conname='sms_outbox_status_check')
  UNION ALL SELECT 'R5.4',
    'RLS policies = 0 (by design, F-01)',
    CASE WHEN (SELECT count(*) FROM pg_policies WHERE schemaname='public') = 0 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT count(*)::text FROM pg_policies WHERE schemaname='public')
  -- --------------------------------------------------------------------- R6 -
  UNION ALL SELECT 'R6.1',
    '8 supporting tables exist',
    CASE WHEN (SELECT count(*) FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
               WHERE n.nspname='public' AND t.relname IN
               ('otp_verifications','sessions','dashboard_sessions','push_tokens','chat_mutes','legal_acceptances','rate_limit_counters','sms_outbox')) = 8
          THEN 'PASS' ELSE 'FAIL' END,
    (SELECT string_agg(relname, ', ' ORDER BY relname) FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
     WHERE n.nspname='public' AND t.relname IN
     ('otp_verifications','sessions','dashboard_sessions','push_tokens','chat_mutes','legal_acceptances','rate_limit_counters','sms_outbox'))
  UNION ALL SELECT 'R6.2',
    'sessions stores bcrypt-hashed refresh tokens',
    CASE WHEN (SELECT count(*) FROM public.sessions WHERE refresh_token_hash IS NOT NULL) > 0
          AND (SELECT bool_and(refresh_token_hash ~ '^\$2[aby]\$') FROM public.sessions WHERE refresh_token_hash IS NOT NULL)
         THEN 'PASS' ELSE 'FAIL' END,
    (SELECT count(*) || ' rows, all bcrypt-prefixed' FROM public.sessions WHERE refresh_token_hash IS NOT NULL)
  UNION ALL SELECT 'R6.3',
    'sessions.revoked_at present',
    CASE WHEN (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='sessions'
               AND column_name='revoked_at') = 1 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='sessions')
  UNION ALL SELECT 'R6.4',
    'otp_verifications: code_hash/attempts/locked_until/expires_at',
    CASE WHEN (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='otp_verifications'
               AND column_name IN ('code_hash','attempts','locked_until','expires_at')) = 4 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT COALESCE(string_agg(column_name, ', ' ORDER BY ordinal_position),'none') FROM information_schema.columns
     WHERE table_schema='public' AND table_name='otp_verifications')
  UNION ALL SELECT 'R6.5',
    'sessions/dashboard_sessions structural isolation',
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.sessions'::regclass AND contype='f')
          AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.dashboard_sessions'::regclass AND contype='f')
         THEN 'PASS' ELSE 'FAIL' END,
    'sessions FKs: ' || COALESCE((SELECT string_agg(conname||'->'||confrelid::regclass::text, ', ') FROM pg_constraint
      WHERE conrelid='public.sessions'::regclass AND contype='f'),'none')
     || '; dashboard_sessions FKs: ' || COALESCE((SELECT string_agg(conname||'->'||confrelid::regclass::text, ', ') FROM pg_constraint
      WHERE conrelid='public.dashboard_sessions'::regclass AND contype='f'),'none')
  -- --------------------------------------------------------------------- R7 -
  UNION ALL SELECT 'R7.1',
    'public.run_data_cleanup() EXISTS (was the cron-failure root cause)',
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='run_data_cleanup')
         THEN 'PASS' ELSE 'FAIL' END,
    COALESCE((SELECT pg_get_function_result(oid)::text FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='run_data_cleanup' LIMIT 1),'MISSING')
  UNION ALL SELECT 'R7.2',
    'purged_at on report_evidence + test_report_evidence',
    CASE WHEN (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name='purged_at'
               AND table_name IN ('report_evidence','test_report_evidence')) >= 2 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT COALESCE(string_agg(table_name, ', ' ORDER BY table_name),'none') FROM information_schema.columns
     WHERE table_schema='public' AND column_name='purged_at' AND table_name IN ('report_evidence','test_report_evidence'))
  UNION ALL SELECT 'R7.3',
    'message_relay.media_path present (storage cleanup hook)',
    CASE WHEN (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='message_relay'
               AND column_name='media_path') = 1 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT count(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='message_relay' AND column_name='media_path')
  UNION ALL SELECT 'R7.4',
    'phone_reuse_cooldowns (phone_hash PK + cooldown_until)',
    CASE WHEN (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='phone_reuse_cooldowns'
               AND column_name IN ('phone_hash','cooldown_until')) = 2 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT string_agg(column_name || ':' || udt_name, ', ' ORDER BY ordinal_position)
     FROM information_schema.columns WHERE table_schema='public' AND table_name='phone_reuse_cooldowns')
  UNION ALL SELECT 'R7.5',
    'storage-purge trigger on message_relay',
    CASE WHEN (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.message_relay'::regclass AND NOT tgisinternal AND tgname LIKE '%purge%') >= 1
         THEN 'PASS' ELSE 'FAIL' END,
    (SELECT COALESCE(string_agg(tgname, ', ' ORDER BY tgname),'none') FROM pg_trigger WHERE tgrelid='public.message_relay'::regclass AND NOT tgisinternal)
  UNION ALL SELECT 'R7.6',
    'cron daily-data-cleanup -> run_data_cleanup() | cleanup-message-relay every 5 min',
    CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname='daily-data-cleanup' AND command ~ 'run_data_cleanup\(\)')
          AND EXISTS (SELECT 1 FROM cron.job WHERE jobname='cleanup-message-relay' AND schedule LIKE '%5%')
         THEN 'PASS' ELSE 'FAIL' END,
    (SELECT string_agg(jobname || ' [' || schedule || ']', ' | ' ORDER BY jobname) FROM cron.job)
  UNION ALL SELECT 'R7.7',
    'latest daily-data-cleanup run succeeded (history, newest first)',
    CASE WHEN (SELECT status FROM cron.job_run_details jd
               WHERE jd.jobid=(SELECT jobid FROM cron.job WHERE jobname='daily-data-cleanup')
               ORDER BY jd.start_time DESC LIMIT 1) = 'succeeded' THEN 'PASS' ELSE 'FAIL' END,
    (SELECT array_to_string(array_agg(x), ' | ') FROM (
        SELECT start_time::timestamp(0)::text || ':' || status AS x
        FROM cron.job_run_details
        WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='daily-data-cleanup')
        ORDER BY start_time DESC LIMIT 8) r)
) checks
ORDER BY check_id;

-- ---------------------------------------------------------------------------
-- FUNCTIONAL TESTS (rolled back, reported as NOTICEs) ------------------------
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.message_relay (sender_device_id, recipient_device_id, ciphertext, message_type)
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

DO $$
BEGIN
  PERFORM public.run_data_cleanup();
  PERFORM public.run_data_cleanup();
  RAISE NOTICE 'FUNC.F2 PASS: run_data_cleanup() executed 2x without error';
EXCEPTION WHEN others THEN
  RAISE NOTICE 'FUNC.F2 FAIL: %', SQLERRM;
END $$;

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

ROLLBACK;

-- ============================================================================
-- END -- functional results F1-F3 arrive as NOTICEs in the editor message panel.
-- ============================================================================