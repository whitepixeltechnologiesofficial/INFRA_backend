-- ============================================================
-- verify_db27.sql — DB-2.7-V re-verification (run AFTER 009)
--
-- Paste the WHOLE file into Supabase → SQL Editor and run.
-- It follows the 13 prepared test cases from the DB-2.7-V card:
--   Section A: static assertions (functions/columns/trigger/table)
--   Section B: run_data_cleanup() functional TCs  (wrapped; ROLLBACK)
--   Section C: cleanup_pending_messages() + Storage TCs (wrapped; ROLLBACK)
--   Section D: force daily-data-cleanup cron run + inspect the log
-- All fabricated data is rolled back — nothing persists.
-- ============================================================

------------------------------------------------------------------
-- SECTION A — Static assertions (post-migration state)
------------------------------------------------------------------

-- A1. Both retention functions exist and return void
SELECT 'A1' AS check_id, p.proname, pg_get_function_result(p.oid) AS returns
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('run_data_cleanup', 'cleanup_pending_messages')
ORDER BY p.proname;

-- A2. daily-data-cleanup cron job points at the new function
SELECT 'A2' AS check_id, jobid, jobname, schedule, left(command, 120) AS command
FROM cron.job ORDER BY jobid;

-- A3. purged_at exists on report_evidence (S15.4)
SELECT 'A3' AS check_id, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'report_evidence' AND column_name = 'purged_at';

-- A4. media_path exists on pending_messages (S11.4)
SELECT 'A4' AS check_id, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pending_messages' AND column_name = 'media_path';

-- A5. Storage-cleanup trigger attached to pending_messages
SELECT 'A5' AS check_id, tgname
FROM pg_trigger
WHERE tgrelid = 'public.pending_messages'::regclass AND NOT tgisinternal;

-- A6. phone_reuse_cooldowns table exists (S6.9)
SELECT 'A6' AS check_id, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'phone_reuse_cooldowns'
ORDER BY ordinal_position;

-- A7. Reassurance: the job body never references blocks/reports
SELECT 'A7' AS check_id,
       position('blocks' in pg_get_functiondef(p.oid))   AS hits_blocks,
       position('reports' in pg_get_functiondef(p.oid))  AS hits_reports
FROM pg_proc p
WHERE p.proname = 'run_data_cleanup' AND p.pronamespace = 'public'::regnamespace;

------------------------------------------------------------------
-- SECTION B — run_data_cleanup() functional test cases
-- Wrapped in a transaction and ROLLED BACK (no data persists).
------------------------------------------------------------------

BEGIN;

-- Test envelope (rollback on any error so a failure is visible)

-- B0. Fabricated fixtures: a test device (user A), a test report,
--     and 4 associations used below. All ids are private to this block.
INSERT INTO public.devices (id, user_id, device_type, platform, identity_public_key)
VALUES ('00000000-0000-0000-0000-00000000d270', 'a2b5a8c6-e3e4-48c3-ac2b-ff64b0231fd0',
        'phone'::public.device_type, 'android'::public.platform, 'verify-db27-key')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.reports (id, reporter_phone_hash, reported_phone_hash, status)
VALUES ('00000000-0000-0000-0000-00000000b701', 'vhash_reporter_1', 'vhash_reported_1',
        'pending'::public.report_status)
ON CONFLICT (id) DO NOTHING;

-- B1 (TC13): recent evidence (captured 1 day ago) -> must SURVIVE
INSERT INTO public.report_evidence
    (id, report_id, message_content, message_created_at, captured_at)
VALUES ('00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-00000000b701',
        'recent evidence', now(), now() - interval '1 day');

-- B2 (TC5): 31-day-old evidence -> must be PURGED
-- (message_created_at stays recent so the 7-day bounding trigger passes;
--  retention is keyed on captured_at per S15.4.)
INSERT INTO public.report_evidence
    (id, report_id, message_content, message_created_at, captured_at)
VALUES ('00000000-0000-0000-0000-00000000e102', '00000000-0000-0000-0000-00000000b701',
        'old evidence', now(), now() - interval '31 days');

-- B3 (TC6): a blocks row that must be untouched
INSERT INTO public.blocks (blocker_phone_hash, blocked_phone_hash)
VALUES ('vhash_blocker', 'vhash_blocked');

-- B4 (TC8/TC9): cooldowns — one not yet expired (must persist),
--     one expired 48h+ ago (must be released)
INSERT INTO public.phone_reuse_cooldowns (phone_hash, cooldown_until)
VALUES ('vhash_cool_active', now() + interval '1 hour');

INSERT INTO public.phone_reuse_cooldowns (phone_hash, cooldown_until)
VALUES ('vhash_cool_due', now() - interval '49 hours');

-- Baseline counts
SELECT 'B-baseline' AS check_id,
       (SELECT COUNT(*) FROM public.report_evidence WHERE report_id = '00000000-0000-0000-0000-00000000b701') AS evidence_rows,
       (SELECT COUNT(*) FROM public.blocks WHERE blocker_phone_hash = 'vhash_blocker') AS block_rows,
       (SELECT COUNT(*) FROM public.phone_reuse_cooldowns WHERE phone_hash IN ('vhash_cool_active','vhash_cool_due')) AS cooldown_rows;

-- B5. Run the cleanup job twice (TC12 idempotency)
SELECT public.run_data_cleanup();
SELECT public.run_data_cleanup();

-- B6. Assertions after the runs
SELECT 'B6' AS check_id,
       (SELECT COUNT(*) FROM public.report_evidence WHERE id = '00000000-0000-0000-0000-00000000e101') AS recent_evidence_left_TC13,
       (SELECT COUNT(*) FROM public.report_evidence WHERE id = '00000000-0000-0000-0000-00000000e102') AS old_evidence_gone_TC5,
       (SELECT COUNT(*) FROM public.blocks WHERE blocker_phone_hash = 'vhash_blocker') AS blocks_untouched_TC6,
       (SELECT COUNT(*) FROM public.reports WHERE id = '00000000-0000-0000-0000-00000000b701') AS reports_untouched_TC7,
       (SELECT COUNT(*) FROM public.phone_reuse_cooldowns WHERE phone_hash = 'vhash_cool_active') AS cooldown_not_early_TC8,
       (SELECT COUNT(*) FROM public.phone_reuse_cooldowns WHERE phone_hash = 'vhash_cool_due') AS cooldown_released_TC9;

-- B7 (TC10): active-profile data untouched (count for user A unchanged)
SELECT 'B7' AS check_id, COUNT(*) AS users_still_present
FROM public.users WHERE id = 'a2b5a8c6-e3e4-48c3-ac2b-ff64b0231fd0';

ROLLBACK;

------------------------------------------------------------------
-- SECTION C — cleanup_pending_messages() + Storage (S6.4 / S11.4)
-- Wrapped in a transaction and ROLLED BACK.
------------------------------------------------------------------

BEGIN;

-- C0. Fixture: one device (reused id), three relay rows + test media
INSERT INTO public.devices (id, user_id, device_type, platform, identity_public_key)
VALUES ('00000000-0000-0000-0000-00000000d270', 'a2b5a8c6-e3e4-48c3-ac2b-ff64b0231fd0',
        'phone'::public.device_type, 'android'::public.platform, 'verify-db27-key')
ON CONFLICT (id) DO NOTHING;

-- TC1: delivered          -> should be deleted by cleanup
INSERT INTO public.pending_messages (id, sender_device_id, recipient_device_id, recipient_user_id, ciphertext, size_bytes, expires_at, delivered_at)
VALUES ('00000000-0000-0000-0000-00000000f201', '00000000-0000-0000-0000-00000000d270',
        '00000000-0000-0000-0000-00000000d270', 'a2b5a8c6-e3e4-48c3-ac2b-ff64b0231fd0',
        decode('cafebabe','hex'), 4, now() + interval '1 day', now());

-- TC2: expired            -> should be deleted by cleanup
INSERT INTO public.pending_messages (id, sender_device_id, recipient_device_id, recipient_user_id, ciphertext, size_bytes, expires_at)
VALUES ('00000000-0000-0000-0000-00000000f202', '00000000-0000-0000-0000-00000000d270',
        '00000000-0000-0000-0000-00000000d270', 'a2b5a8c6-e3e4-48c3-ac2b-ff64b0231fd0',
        decode('cafebabe','hex'), 4, now() - interval '1 hour');

-- TC3: neither            -> must SURVIVE cleanup
INSERT INTO public.pending_messages (id, sender_device_id, recipient_device_id, recipient_user_id, ciphertext, size_bytes, expires_at)
VALUES ('00000000-0000-0000-0000-00000000f203', '00000000-0000-0000-0000-00000000d270',
        '00000000-0000-0000-0000-00000000d270', 'a2b5a8c6-e3e4-48c3-ac2b-ff64b0231fd0',
        decode('cafebabe','hex'), 4, now() + interval '1 day');

-- TC4: media object + relay row carrying media_path
INSERT INTO storage.buckets (id, name)
VALUES ('verify-bucket', 'verify-bucket')
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.objects (id, bucket_id, name)
VALUES (gen_random_uuid(), 'verify-bucket', 'verify-tc4-media.jpg');

INSERT INTO public.pending_messages (id, sender_device_id, recipient_device_id, recipient_user_id, ciphertext, size_bytes, expires_at, media_path)
VALUES ('00000000-0000-0000-0000-00000000f204', '00000000-0000-0000-0000-00000000d270',
        '00000000-0000-0000-0000-00000000d270', 'a2b5a8c6-e3e4-48c3-ac2b-ff64b0231fd0',
        decode('cafebabe','hex'), 4, now() - interval '1 hour', 'verify-tc4-media.jpg');

-- Run the 5-minute cleanup job once
SELECT public.cleanup_pending_messages();

-- C1. delivered + expired rows gone; "neither" row survives
SELECT 'C1' AS check_id,
       (SELECT COUNT(*) FROM public.pending_messages WHERE id = '00000000-0000-0000-0000-00000000f201') AS delivered_gone_TC1,
       (SELECT COUNT(*) FROM public.pending_messages WHERE id = '00000000-0000-0000-0000-00000000f202') AS expired_gone_TC2,
       (SELECT COUNT(*) FROM public.pending_messages WHERE id = '00000000-0000-0000-0000-00000000f203') AS neither_survives_TC3;

-- C2. The media_path row was deleted -> Storage object must be gone too
SELECT 'C2' AS check_id,
       (SELECT COUNT(*) FROM public.pending_messages WHERE id = '00000000-0000-0000-0000-00000000f204') AS relay_row_gone,
       (SELECT COUNT(*) FROM storage.objects WHERE name = 'verify-tc4-media.jpg') AS storage_object_gone_TC4;

ROLLBACK;

------------------------------------------------------------------
-- SECTION D — Prove the daily-data-cleanup job's command now succeeds.
-- NOTE: cron.run_job() is not exposed on this Supabase instance, so we
-- cannot force the scheduler. Instead we invoke the exact function the
-- cron job calls (its command is `select public.run_data_cleanup();`)
-- and confirm the scheduler is still pointed at it. The next scheduled
-- 03:00 run will record a SUCCEEDS row in cron.job_run_details.
------------------------------------------------------------------

-- D1. The exact command the daily-data-cleanup job executes — must run
--     without error (previously it raised "function does not exist").
SELECT public.run_data_cleanup();

-- D2. Confirm the scheduler still points at the now-created function
SELECT 'D2' AS check_id, jobid, jobname, schedule, left(command, 120) AS command
FROM cron.job WHERE jobname = 'daily-data-cleanup';

-- D3. Last recorded runs (old FAILED rows are historical, pre-fix).
--     After the next 03:00 run this list should show a SUCCEEDS row.
SELECT 'D3' AS check_id, status, return_message, start_time
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'daily-data-cleanup')
ORDER BY start_time DESC
LIMIT 5;

-- Expected final state:
--   * run_data_cleanup(): every failure row turns into SUCCEEDS
--   * B6 shows: TC13 recent evidence has 1 row left, TC5 old evidence = 0
--   * blocks_untouched = 1, reports_untouched = 1 (never touched)
--   * cooldown_not_early = 1, cooldown_released = 0
--   * C1 delivered_gone = 0, expired_gone = 0, neither_survives = 1
--   * C2 storage_object_gone = 0 (object was deleted alongside its row)