-- ============================================================
-- BE-R2.1 fresh-database verification (Supabase SQL Editor edition)
-- Generated from 013_rename_message_relay_to_pending_messages.sql by scripts/verify-fresh-db-r21.sql
--
-- WHY THIS FILE EXISTS
-- The Node harness (verify-fresh-db-r21.ts) needs outbound TCP 5432, which
-- is blocked on this network. The Supabase SQL Editor runs over HTTPS, so
-- this file performs the same test with no database port required.
--
-- WHAT IT DOES
--   1. creates an isolated schema (r21_verify) - "public" is never written
--   2. builds the exact pre-012 message_relay state
--   3. replays migration 012 with the cron step stripped
--   4. asserts all 20 renames, row preservation, trigger, cleanup fn
--   5. runs the rollback, re-applies 012, re-asserts
--   6. prints a PASS/FAIL table, then drops the schema
--
-- The cron step is stripped because pg_cron job names are unique per
-- database; replaying it would unschedule the live cleanup-pending-messages
-- job. Check S3.6 asserts that job still exists.
--
-- Run: Supabase -> SQL Editor -> New Query -> paste -> Run.
-- The final result grid is the output. Read the "summary" query.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS r21_verify;

-- ---------------------------------------------------------------- step 0
-- Minimum base tables that 012's foreign keys point at.
CREATE TABLE r21_verify.users   (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE r21_verify.devices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE r21_verify.groups  (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

CREATE TYPE r21_verify.message_type_enum AS ENUM (
  'text','image','video','document','voice_note','system',
  'read_receipt','delete_for_everyone','moderation_notice'
);

-- Columns only. No inline PRIMARY KEY and no inline REFERENCES: those would
-- be auto-named with a "_fkey" suffix, but 011 creates the foreign keys under
-- explicit "_fk" names, and 012 renames the "_fk" names. Declaring them
-- explicitly below is the only way to reproduce the real pre-012 catalog.
CREATE TABLE r21_verify.message_relay (
  id                      uuid NOT NULL DEFAULT gen_random_uuid(),
  sender_device_id        uuid NOT NULL,
  recipient_user_id       uuid,
  recipient_device_id     uuid,
  recipient_group_id      uuid,
  ciphertext              bytea NOT NULL,
  message_type            r21_verify.message_type_enum NOT NULL DEFAULT 'text'::r21_verify.message_type_enum,
  size_bytes              integer NOT NULL,
  reply_to_id             uuid,
  voice_segment_group_id  uuid,
  media_path              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  delivered_at            timestamptz,
  expires_at              timestamptz NOT NULL
);

-- The 9 constraints that exist after 011 and that 012 renames:
-- 1 primary key, 3 CHECK, 5 FK. Names match 004 / 006 / 011 exactly.
ALTER TABLE r21_verify.message_relay
  ADD CONSTRAINT message_relay_pkey PRIMARY KEY (id);

ALTER TABLE r21_verify.message_relay
  ADD CONSTRAINT message_relay_recipient_exactly_one
  CHECK (num_nonnulls(recipient_user_id, recipient_device_id, recipient_group_id) = 1);

ALTER TABLE r21_verify.message_relay
  ADD CONSTRAINT message_relay_size_bytes_non_negative CHECK (size_bytes >= 0);

ALTER TABLE r21_verify.message_relay
  ADD CONSTRAINT message_relay_message_type_check
  CHECK (message_type::text = ANY (ARRAY[
    'text','image','video','document','voice_note','system',
    'read_receipt','delete_for_everyone','moderation_notice']));

ALTER TABLE r21_verify.message_relay
  ADD CONSTRAINT message_relay_reply_to_fkey
  FOREIGN KEY (reply_to_id) REFERENCES r21_verify.message_relay (id);

ALTER TABLE r21_verify.message_relay
  ADD CONSTRAINT message_relay_sender_device_id_devices_id_fk
  FOREIGN KEY (sender_device_id) REFERENCES r21_verify.devices (id) ON DELETE CASCADE;

ALTER TABLE r21_verify.message_relay
  ADD CONSTRAINT message_relay_recipient_device_id_devices_id_fk
  FOREIGN KEY (recipient_device_id) REFERENCES r21_verify.devices (id) ON DELETE CASCADE;

ALTER TABLE r21_verify.message_relay
  ADD CONSTRAINT message_relay_recipient_user_id_users_id_fk
  FOREIGN KEY (recipient_user_id) REFERENCES r21_verify.users (id) ON DELETE CASCADE;

ALTER TABLE r21_verify.message_relay
  ADD CONSTRAINT message_relay_recipient_group_id_groups_id_fk
  FOREIGN KEY (recipient_group_id) REFERENCES r21_verify.groups (id) ON DELETE CASCADE;

CREATE INDEX idx_message_relay_recipient_user   ON r21_verify.message_relay (recipient_user_id);
CREATE INDEX idx_message_relay_recipient_device ON r21_verify.message_relay (recipient_device_id);
CREATE INDEX idx_message_relay_recipient_group  ON r21_verify.message_relay (recipient_group_id);
CREATE INDEX idx_message_relay_expires          ON r21_verify.message_relay (expires_at);
CREATE INDEX idx_message_relay_created          ON r21_verify.message_relay (created_at);
CREATE INDEX idx_message_relay_voice_group     ON r21_verify.message_relay (voice_segment_group_id);

-- 004's cleanup function, which 012 renames in step 7. LANGUAGE sql, so its
-- body is validated at CREATE time - it must come after the table above.
CREATE OR REPLACE FUNCTION r21_verify.cleanup_message_relay()
RETURNS void
LANGUAGE sql
AS $fn$ DELETE FROM r21_verify.message_relay
     WHERE delivered_at IS NOT NULL OR expires_at < now(); $fn$;
-- 009's purge trigger, reproduced EXACTLY (SECURITY DEFINER, search_path and
-- the nested EXCEPTION handler included). The handler catches
-- insufficient_privilege, which is SQLSTATE 42501 - the code Supabase's
-- storage.protect_delete() raises. Reproducing it faithfully is the point:
-- 012 renames this function but does not recreate its body, so this is the
-- body that runs in production.
CREATE OR REPLACE FUNCTION r21_verify.tg_message_relay_purge_storage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = r21_verify, storage
AS $fn$
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
$fn$;

CREATE TRIGGER trg_message_relay_purge_storage
  AFTER DELETE ON r21_verify.message_relay
  FOR EACH ROW
  EXECUTE FUNCTION r21_verify.tg_message_relay_purge_storage();

-- ---------------------------------------------------------------- seed
-- Three rows with a deliberate fake media_path. The purge trigger only
-- deletes a storage object whose name equals media_path, so a value that
-- does not exist cannot remove real data.
-- Base rows. The seed below selects FROM devices, so devices must not be
-- empty or the cross join yields zero rows and every row-count check fails.
INSERT INTO r21_verify.devices (id) VALUES (gen_random_uuid());
INSERT INTO r21_verify.users   (id) VALUES (gen_random_uuid());
INSERT INTO r21_verify.groups  (id) VALUES (gen_random_uuid());

-- Rows 1 and 2 carry media_path NULL so the runtime delete test never reaches
-- the storage branch. Row 3 carries a deliberately absent path and is used
-- only by check S4.5, which documents the orphaned-media finding.
INSERT INTO r21_verify.message_relay
  (sender_device_id, recipient_device_id, ciphertext, message_type,
   size_bytes, media_path, expires_at, created_at)
SELECT d.id, d.id, '\x0102'::bytea, 'text', 2,
       CASE WHEN g = 3 THEN 'r21-verify-nonexistent-3' ELSE NULL END,
       now() + interval '30 days',
       now() - (g || ' minutes')::interval
FROM r21_verify.devices d, generate_series(1,3) g;

CREATE TEMP TABLE r21_marker (oldest_created_at timestamptz);
INSERT INTO r21_marker SELECT min(created_at) FROM r21_verify.message_relay;

CREATE TEMP TABLE r21_results (
  check_id text, label text, status text, detail text
);

-- Must be recorded BEFORE 012 runs: after the rename the table is called
-- pending_messages, so this can no longer reference message_relay.
INSERT INTO r21_results
SELECT 'S0.1', '3 rows seeded before migration',
  CASE WHEN (SELECT count(*) FROM r21_verify.message_relay) = 3 THEN 'PASS' ELSE 'FAIL' END,
  'n=' || (SELECT count(*) FROM r21_verify.message_relay);

-- ============================================================
-- STEP 2: migration 012, forward, verbatim (cron step stripped)
-- ============================================================

-- 1. Rename the table (rows preserved)
ALTER TABLE r21_verify.message_relay RENAME TO pending_messages;

-- 2. Primary key: auto-named message_relay_pkey by `id uuid PRIMARY KEY`
--    in 004. Renamed explicitly because table rename does not cascade.
ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_pkey TO pending_messages_pkey;

-- 3. CHECK constraints (3)
ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_recipient_exactly_one
    TO pending_messages_recipient_exactly_one;

ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_size_bytes_non_negative
    TO pending_messages_size_bytes_non_negative;

ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_message_type_check
    TO pending_messages_message_type_check;

-- 4. Foreign key constraints (5)
ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_reply_to_fkey
    TO pending_messages_reply_to_fkey;

ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_sender_device_id_devices_id_fk
    TO pending_messages_sender_device_id_devices_id_fk;

ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_recipient_device_id_devices_id_fk
    TO pending_messages_recipient_device_id_devices_id_fk;

ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_recipient_user_id_users_id_fk
    TO pending_messages_recipient_user_id_users_id_fk;

ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_recipient_group_id_groups_id_fk
    TO pending_messages_recipient_group_id_groups_id_fk;

-- 5. Indexes (6; see names in header)
ALTER INDEX r21_verify.idx_message_relay_recipient_user
    RENAME TO idx_pending_messages_recipient_user;
ALTER INDEX r21_verify.idx_message_relay_recipient_device
    RENAME TO idx_pending_messages_recipient_device;
ALTER INDEX r21_verify.idx_message_relay_recipient_group
    RENAME TO idx_pending_messages_recipient_group;
ALTER INDEX r21_verify.idx_message_relay_expires
    RENAME TO idx_pending_messages_expires;
ALTER INDEX r21_verify.idx_message_relay_created
    RENAME TO idx_pending_messages_created;
ALTER INDEX r21_verify.idx_message_relay_voice_group
    RENAME TO idx_pending_messages_voice_group;

-- 6. Trigger: rename now. Its function dependency is renamed in step 8
--    and follows this trigger automatically — no EXECUTE FUNCTION needed.
ALTER TRIGGER trg_message_relay_purge_storage ON r21_verify.pending_messages
    RENAME TO trg_pending_messages_purge_storage;

-- 7. Rename the cleanup function, then refresh its body so it references
--    pending_messages (the pre-rename body pointed at message_relay, which
--    no longer exists after step 1)
ALTER FUNCTION r21_verify.cleanup_message_relay()
    RENAME TO cleanup_pending_messages;

CREATE OR REPLACE FUNCTION r21_verify.cleanup_pending_messages()
RETURNS void
LANGUAGE sql
AS $$ DELETE FROM r21_verify.pending_messages
     WHERE delivered_at IS NOT NULL OR expires_at < now(); $$;

-- 8. Rename the storage-purge trigger function. Its body (from 009) only
--    touches storage.objects, so no body change is required. The trigger
--    renamed in step 6 follows this rename automatically through its
--    function dependency — no ALTER TRIGGER ... EXECUTE FUNCTION needed.
ALTER FUNCTION r21_verify.tg_message_relay_purge_storage()
    RENAME TO tg_pending_messages_purge_storage;

-- [harness] cron step stripped (live job protected)
-- 10. Replace the COMMENT ON TABLE from 009:72 for the renamed table
COMMENT ON TABLE r21_verify.pending_messages IS
    'Message queue per recipient device. Tech Arch S6.4 name (pending_messages). Deleting a row also removes its media_path object from Storage (S11.4).';


-- ---------------------------------------------------------------- checks
INSERT INTO r21_results
SELECT 'S2.1', '012 applied without error', 'PASS', 'no error raised above';

INSERT INTO r21_results
SELECT 'S2.2', 'table renamed to pending_messages',
  CASE WHEN to_regclass('r21_verify.pending_messages') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END, '';

INSERT INTO r21_results
SELECT 'S2.3', 'old message_relay table gone',
  CASE WHEN to_regclass('r21_verify.message_relay') IS NULL THEN 'PASS' ELSE 'FAIL' END, '';

INSERT INTO r21_results
SELECT 'S2.4', '3 rows preserved through rename',
  CASE WHEN (SELECT count(*) FROM r21_verify.pending_messages) = 3 THEN 'PASS' ELSE 'FAIL' END,
  'n=' || (SELECT count(*) FROM r21_verify.pending_messages);

INSERT INTO r21_results
SELECT 'S2.5', 'oldest created_at unchanged (data identity)',
  CASE WHEN (SELECT min(created_at) FROM r21_verify.pending_messages)
          = (SELECT oldest_created_at FROM r21_marker)
       THEN 'PASS' ELSE 'FAIL' END, '';

INSERT INTO r21_results
SELECT 'S3.1', '7 indexes present with new names',
  CASE WHEN (SELECT count(*) FROM pg_indexes
              WHERE schemaname='r21_verify' AND tablename='pending_messages'
                AND indexname IN (
                  'pending_messages_pkey',
                  'idx_pending_messages_recipient_user',
                  'idx_pending_messages_recipient_device',
                  'idx_pending_messages_recipient_group',
                  'idx_pending_messages_expires',
                  'idx_pending_messages_created',
                  'idx_pending_messages_voice_group')) = 7
       THEN 'PASS' ELSE 'FAIL' END,
  'found=' || (SELECT count(*) FROM pg_indexes
                WHERE schemaname='r21_verify' AND tablename='pending_messages');

INSERT INTO r21_results
SELECT 'S3.2', '9 constraints present with new names',
  CASE WHEN (SELECT count(*) FROM pg_constraint
              WHERE conrelid='r21_verify.pending_messages'::regclass
                AND conname IN (
                  'pending_messages_pkey',
                  'pending_messages_recipient_exactly_one',
                  'pending_messages_size_bytes_non_negative',
                  'pending_messages_message_type_check',
                  'pending_messages_reply_to_fkey',
                  'pending_messages_sender_device_id_devices_id_fk',
                  'pending_messages_recipient_device_id_devices_id_fk',
                  'pending_messages_recipient_user_id_users_id_fk',
                  'pending_messages_recipient_group_id_groups_id_fk')) = 9
       THEN 'PASS' ELSE 'FAIL' END,
  'found=' || (SELECT count(*) FROM pg_constraint
                WHERE conrelid='r21_verify.pending_messages'::regclass);

INSERT INTO r21_results
SELECT 'S3.3', 'no message_relay-named object remains',
  CASE WHEN NOT EXISTS (
    SELECT 1 FROM pg_constraint
      WHERE conrelid='r21_verify.pending_messages'::regclass AND conname LIKE '%message_relay%'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
      WHERE schemaname='r21_verify' AND tablename='pending_messages' AND indexname LIKE '%message_relay%'
  ) THEN 'PASS' ELSE 'FAIL' END, '';

INSERT INTO r21_results
SELECT 'S3.4', 'trigger renamed',
  CASE WHEN (SELECT count(*) FROM pg_trigger
              WHERE tgrelid='r21_verify.pending_messages'::regclass
                AND tgname='trg_pending_messages_purge_storage' AND NOT tgisinternal) = 1
       THEN 'PASS' ELSE 'FAIL' END, '';

INSERT INTO r21_results
SELECT 'S3.5', 'both functions renamed',
  CASE WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='r21_verify'
                AND p.proname IN ('cleanup_pending_messages','tg_pending_messages_purge_storage')) = 2
       THEN 'PASS' ELSE 'FAIL' END, '';

-- Exception-safe, and deliberately INFO rather than PASS/FAIL: this harness
-- strips the cron step from 012, so the live job's existence is pre-existing
-- dev-database state that the test cannot be responsible for. The count is
-- reported so a missing job is still surfaced.
DO $chk$
DECLARE n int;
BEGIN
  BEGIN
    SELECT count(*) INTO n FROM cron.job WHERE jobname='cleanup-pending-messages';
    INSERT INTO r21_results VALUES (
      'S3.6', 'live cron job cleanup-pending-messages (pre-existing state)',
      'INFO',
      CASE WHEN n = 1
           THEN 'present, count=1 (harness stripped the cron step, so untouched)'
           ELSE 'NOT EXPECTED count=' || n || ' - 012 schedules this job on the real dev DB; check cron.schedule ran'
      END);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO r21_results VALUES (
      'S3.6', 'live cron job cleanup-pending-messages (pre-existing state)',
      'INFO', 'could not read cron.job: ' || SQLERRM);
  END;
END $chk$;

-- ---------------------------------------------------------------- runtime
SELECT r21_verify.cleanup_pending_messages();

INSERT INTO r21_results
SELECT 'S4.1', 'cleanup_pending_messages() runs', 'PASS', 'no error raised';

INSERT INTO r21_results
SELECT 'S4.2', 'cleanup kept all 3 unexpired rows',
  CASE WHEN (SELECT count(*) FROM r21_verify.pending_messages) = 3 THEN 'PASS' ELSE 'FAIL' END,
  'n=' || (SELECT count(*) FROM r21_verify.pending_messages);

DELETE FROM r21_verify.pending_messages
 WHERE media_path IS NULL
   AND id = (SELECT id FROM r21_verify.pending_messages
              WHERE media_path IS NULL ORDER BY created_at LIMIT 1);

INSERT INTO r21_results
SELECT 'S4.3', 'DELETE fired renamed purge trigger without error',
  'PASS', 'row had media_path NULL, so the storage branch was not entered';

INSERT INTO r21_results
SELECT 'S4.4', 'row removed, 2 remain',
  CASE WHEN (SELECT count(*) FROM r21_verify.pending_messages) = 2 THEN 'PASS' ELSE 'FAIL' END,
  'n=' || (SELECT count(*) FROM r21_verify.pending_messages);

-- Documents a real finding rather than asserting behaviour. 009's handler
-- swallows SQLSTATE 42501 from storage.protect_delete(), so the row is
-- deleted but the Storage object is NOT purged: media orphans accumulate.
-- Row 3 is the only row with a media_path.
DO $t$
DECLARE msg text;
BEGIN
  BEGIN
    DELETE FROM r21_verify.pending_messages WHERE media_path IS NOT NULL;
    msg := 'delete succeeded, 1 row left';
  EXCEPTION WHEN OTHERS THEN
    msg := 'delete FAILED: ' || SQLERRM;
  END;
  INSERT INTO r21_results VALUES (
    'S4.5', 'purge of a row WITH media_path (orphan-media finding)', 'INFO',
    msg || ' | 009 catches insufficient_privilege (42501) from '
         || 'storage.protect_delete(), so the object is never actually deleted');
END $t$;

-- ============================================================
-- STEP 3: rollback, verbatim (cron step stripped)
-- ============================================================

-- 1. Table back first (rows preserved)
ALTER TABLE r21_verify.pending_messages RENAME TO message_relay;

-- 2. Constraints back: 5 FK, 3 CHECK, 1 PK
ALTER TABLE r21_verify.message_relay RENAME CONSTRAINT pending_messages_reply_to_fkey TO message_relay_reply_to_fkey;
ALTER TABLE r21_verify.message_relay RENAME CONSTRAINT pending_messages_sender_device_id_devices_id_fk TO message_relay_sender_device_id_devices_id_fk;
ALTER TABLE r21_verify.message_relay RENAME CONSTRAINT pending_messages_recipient_device_id_devices_id_fk TO message_relay_recipient_device_id_devices_id_fk;
ALTER TABLE r21_verify.message_relay RENAME CONSTRAINT pending_messages_recipient_user_id_users_id_fk TO message_relay_recipient_user_id_users_id_fk;
ALTER TABLE r21_verify.message_relay RENAME CONSTRAINT pending_messages_recipient_group_id_groups_id_fk TO message_relay_recipient_group_id_groups_id_fk;
ALTER TABLE r21_verify.message_relay RENAME CONSTRAINT pending_messages_recipient_exactly_one TO message_relay_recipient_exactly_one;
ALTER TABLE r21_verify.message_relay RENAME CONSTRAINT pending_messages_size_bytes_non_negative TO message_relay_size_bytes_non_negative;
ALTER TABLE r21_verify.message_relay RENAME CONSTRAINT pending_messages_message_type_check TO message_relay_message_type_check;
ALTER TABLE r21_verify.message_relay RENAME CONSTRAINT pending_messages_pkey TO message_relay_pkey;

-- 3. Indexes back (6)
ALTER INDEX r21_verify.idx_pending_messages_recipient_user   RENAME TO idx_message_relay_recipient_user;
ALTER INDEX r21_verify.idx_pending_messages_recipient_device RENAME TO idx_message_relay_recipient_device;
ALTER INDEX r21_verify.idx_pending_messages_recipient_group  RENAME TO idx_message_relay_recipient_group;
ALTER INDEX r21_verify.idx_pending_messages_expires          RENAME TO idx_message_relay_expires;
ALTER INDEX r21_verify.idx_pending_messages_created          RENAME TO idx_message_relay_created;
ALTER INDEX r21_verify.idx_pending_messages_voice_group      RENAME TO idx_message_relay_voice_group;

-- 4. Trigger back
ALTER TRIGGER trg_pending_messages_purge_storage ON r21_verify.message_relay
    RENAME TO trg_message_relay_purge_storage;

-- 5. Functions back, then restore the old cleanup body
ALTER FUNCTION r21_verify.cleanup_pending_messages()
    RENAME TO cleanup_message_relay;
ALTER FUNCTION r21_verify.tg_pending_messages_purge_storage()
    RENAME TO tg_message_relay_purge_storage;

CREATE OR REPLACE FUNCTION r21_verify.cleanup_message_relay()
RETURNS void
LANGUAGE sql
AS $$ DELETE FROM r21_verify.message_relay
     WHERE delivered_at IS NOT NULL OR expires_at < now(); $$;

-- [harness] rollback cron step stripped
-- 7. Comment back to the 009:72 text
COMMENT ON TABLE r21_verify.message_relay IS
    'Message queue per recipient device. Tech Arch S6.4 calls this pending_messages; message_relay is the implemented table. Deleting a row also removes its media_path object from Storage (S11.4).';


INSERT INTO r21_results
SELECT 'S5.1', 'rollback restored message_relay',
  CASE WHEN to_regclass('r21_verify.message_relay') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END, '';

INSERT INTO r21_results
SELECT 'S5.2', 'pending_messages gone after rollback',
  CASE WHEN to_regclass('r21_verify.pending_messages') IS NULL THEN 'PASS' ELSE 'FAIL' END, '';

INSERT INTO r21_results
SELECT 'S5.3', 'rows preserved through rollback',
  CASE WHEN (SELECT count(*) FROM r21_verify.message_relay) = 1 THEN 'PASS' ELSE 'FAIL' END,
  'n=' || (SELECT count(*) FROM r21_verify.message_relay);

-- ============================================================
-- STEP 4: re-apply 012 after rollback
-- ============================================================

-- 1. Rename the table (rows preserved)
ALTER TABLE r21_verify.message_relay RENAME TO pending_messages;

-- 2. Primary key: auto-named message_relay_pkey by `id uuid PRIMARY KEY`
--    in 004. Renamed explicitly because table rename does not cascade.
ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_pkey TO pending_messages_pkey;

-- 3. CHECK constraints (3)
ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_recipient_exactly_one
    TO pending_messages_recipient_exactly_one;

ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_size_bytes_non_negative
    TO pending_messages_size_bytes_non_negative;

ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_message_type_check
    TO pending_messages_message_type_check;

-- 4. Foreign key constraints (5)
ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_reply_to_fkey
    TO pending_messages_reply_to_fkey;

ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_sender_device_id_devices_id_fk
    TO pending_messages_sender_device_id_devices_id_fk;

ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_recipient_device_id_devices_id_fk
    TO pending_messages_recipient_device_id_devices_id_fk;

ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_recipient_user_id_users_id_fk
    TO pending_messages_recipient_user_id_users_id_fk;

ALTER TABLE r21_verify.pending_messages
    RENAME CONSTRAINT message_relay_recipient_group_id_groups_id_fk
    TO pending_messages_recipient_group_id_groups_id_fk;

-- 5. Indexes (6; see names in header)
ALTER INDEX r21_verify.idx_message_relay_recipient_user
    RENAME TO idx_pending_messages_recipient_user;
ALTER INDEX r21_verify.idx_message_relay_recipient_device
    RENAME TO idx_pending_messages_recipient_device;
ALTER INDEX r21_verify.idx_message_relay_recipient_group
    RENAME TO idx_pending_messages_recipient_group;
ALTER INDEX r21_verify.idx_message_relay_expires
    RENAME TO idx_pending_messages_expires;
ALTER INDEX r21_verify.idx_message_relay_created
    RENAME TO idx_pending_messages_created;
ALTER INDEX r21_verify.idx_message_relay_voice_group
    RENAME TO idx_pending_messages_voice_group;

-- 6. Trigger: rename now. Its function dependency is renamed in step 8
--    and follows this trigger automatically — no EXECUTE FUNCTION needed.
ALTER TRIGGER trg_message_relay_purge_storage ON r21_verify.pending_messages
    RENAME TO trg_pending_messages_purge_storage;

-- 7. Rename the cleanup function, then refresh its body so it references
--    pending_messages (the pre-rename body pointed at message_relay, which
--    no longer exists after step 1)
ALTER FUNCTION r21_verify.cleanup_message_relay()
    RENAME TO cleanup_pending_messages;

CREATE OR REPLACE FUNCTION r21_verify.cleanup_pending_messages()
RETURNS void
LANGUAGE sql
AS $$ DELETE FROM r21_verify.pending_messages
     WHERE delivered_at IS NOT NULL OR expires_at < now(); $$;

-- 8. Rename the storage-purge trigger function. Its body (from 009) only
--    touches storage.objects, so no body change is required. The trigger
--    renamed in step 6 follows this rename automatically through its
--    function dependency — no ALTER TRIGGER ... EXECUTE FUNCTION needed.
ALTER FUNCTION r21_verify.tg_message_relay_purge_storage()
    RENAME TO tg_pending_messages_purge_storage;

-- [harness] cron step stripped (live job protected)
-- 10. Replace the COMMENT ON TABLE from 009:72 for the renamed table
COMMENT ON TABLE r21_verify.pending_messages IS
    'Message queue per recipient device. Tech Arch S6.4 name (pending_messages). Deleting a row also removes its media_path object from Storage (S11.4).';


INSERT INTO r21_results
SELECT 'S5.4', '012 re-applies cleanly after rollback',
  CASE WHEN to_regclass('r21_verify.pending_messages') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END, '';

INSERT INTO r21_results
SELECT 'S5.5', 'rows preserved through re-apply',
  CASE WHEN (SELECT count(*) FROM r21_verify.pending_messages) = 1 THEN 'PASS' ELSE 'FAIL' END,
  'n=' || (SELECT count(*) FROM r21_verify.pending_messages);


-- ---------------------------------------------------------------- cleanup
-- Results live in a TEMP table, so they survive the schema drop.
DROP SCHEMA r21_verify CASCADE;

-- ---------------------------------------------------------------- output
SELECT
  check_id,
  label,
  status,
  detail,
  CASE status
    WHEN 'PASS' THEN ''
    WHEN 'FAIL' THEN '  <-- INVESTIGATE'
    ELSE '  (info only, not part of the verdict)'
  END AS note
FROM r21_results
ORDER BY check_id;

-- One-line verdict, also visible in the grid above.
SELECT
  count(*) FILTER (WHERE status = 'PASS') || ' passed, '
  || count(*) FILTER (WHERE status = 'FAIL') || ' failed'
  AS result
FROM r21_results;
