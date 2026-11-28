-- ============================================================
-- 021_db26_supporting_tables.sql
-- DB-2.6 — Supporting tables. Tech Arch §6.8.
--
-- WHY THIS MIGRATION EXISTS
--   The Sprint 1–3 status report marked DB-2.6 "Error": four of the
--   eight supporting tables were never created on main:
--     dashboard_sessions, push_tokens, chat_mutes, rate_limit_counters
--   The other four already exist and are NOT touched here:
--     otp_verifications, sessions, legal_acceptances, sms_outbox
--
-- SESSIONS vs DASHBOARD_SESSIONS (deliberately two tables)
--   dashboard_sessions is a SEPARATE table, not a "type" column on
--   sessions. Admin auth is isolated from user auth:
--     - sessions           -> user/device sessions, no FK (user_id + device_id)
--     - dashboard_sessions -> FK ONLY to dashboard_admins(id)
--   A dashboard token can never be looked up as a user session and
--   vice versa. scripts/verify_all.sql check R6.5 asserts exactly this.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE throughout.
-- Run this in: Supabase → SQL Editor → New Query → Run
-- Then run scripts/verify-db26.sql.
-- ============================================================

BEGIN;

-- ── 1. dashboard_sessions ───────────────────────────────────
-- Column layout matches the table already live on Supabase, created by
-- the dashboard-auth work (src/auth/dashboard.ts): token_lookup (first
-- 32 hex chars of SHA-256) for indexed lookup, refresh_token_hash
-- (bcrypt), refresh_token_expires_at, and revoked_at as the kill switch.
-- Belongs ONLY to dashboard_admins.
CREATE TABLE IF NOT EXISTS public.dashboard_sessions (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id                 uuid NOT NULL
        CONSTRAINT dashboard_sessions_admin_id_fk
        REFERENCES public.dashboard_admins (id) ON DELETE CASCADE,
    token_lookup             varchar(32) NOT NULL,
    refresh_token_hash       varchar(60) NOT NULL,
    refresh_token_expires_at timestamptz NOT NULL,
    revoked_at               timestamptz,
    ip_address               varchar(45),
    user_agent               text,
    created_at               timestamptz NOT NULL DEFAULT now()
);

-- A table created earlier without the link (Drizzle push from another
-- branch) gets it here. NOT VALID: enforced for every new row without
-- failing on any historical orphan.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.dashboard_sessions'::regclass
          AND contype = 'f'
          AND confrelid = 'public.dashboard_admins'::regclass
    ) THEN
        ALTER TABLE public.dashboard_sessions
            ADD CONSTRAINT dashboard_sessions_admin_id_fk
            FOREIGN KEY (admin_id) REFERENCES public.dashboard_admins (id)
            ON DELETE CASCADE NOT VALID;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS dashboard_sessions_admin_id_idx
    ON public.dashboard_sessions (admin_id);
CREATE INDEX IF NOT EXISTS dashboard_sessions_token_lookup_idx
    ON public.dashboard_sessions (token_lookup);
CREATE INDEX IF NOT EXISTS dashboard_sessions_revoked_at_idx
    ON public.dashboard_sessions (revoked_at);

-- ── 1b. Older, incompatible copies of the next three tables ─
-- Supabase already had push_tokens (user_id/platform), chat_mutes and
-- rate_limit_counters in a different, EMPTY shape, so CREATE TABLE IF
-- NOT EXISTS skipped them and the indexes below failed. An empty table
-- in the old shape is rebuilt; one that holds rows stops the migration
-- instead of losing data.
DO $$
DECLARE
    t      text;
    marker text;
    n      bigint;
BEGIN
    FOR t, marker IN VALUES ('push_tokens', 'device_id'),
                            ('chat_mutes', 'muted_user_id'),
                            ('rate_limit_counters', 'window_start')
    LOOP
        IF to_regclass('public.' || t) IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = t AND column_name = marker
        ) THEN
            EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
            IF n > 0 THEN
                RAISE EXCEPTION 'DB-2.6: public.% exists in an older layout and has % row(s); migrate it by hand', t, n;
            END IF;
            EXECUTE format('DROP TABLE public.%I', t);
        END IF;
    END LOOP;
END
$$;

-- ── 2. push_tokens ──────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'push_provider') THEN
        CREATE TYPE public.push_provider AS ENUM ('fcm', 'apns', 'web_push');
    END IF;
END
$$;

-- One token per device per provider. Deleting a device (unlink /
-- revoke) deletes its push token so no notification reaches it.
CREATE TABLE IF NOT EXISTS public.push_tokens (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id  uuid NOT NULL
        CONSTRAINT push_tokens_device_id_fk
        REFERENCES public.devices (id) ON DELETE CASCADE,
    provider   public.push_provider NOT NULL,
    -- FCM/APNs registration token, or the Web Push subscription JSON
    -- (endpoint + keys) serialized as text.
    token      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT push_tokens_token_not_empty_chk CHECK (length(token) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_device_provider_uidx
    ON public.push_tokens (device_id, provider);
-- The same token must not be registered to two devices.
CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_provider_token_uidx
    ON public.push_tokens (provider, token);

-- ── 3. chat_mutes ───────────────────────────────────────────
-- A mute targets EITHER a 1:1 chat (muted_user_id) OR a group
-- (group_id), never both. muted_until NULL = muted indefinitely.
-- user_id / muted_user_id take the live type of users.id (uuid in
-- production per migration 008) so the FKs always line up.
DO $$
DECLARE
    v_uid_type text;
BEGIN
    IF to_regclass('public.chat_mutes') IS NULL THEN
        SELECT format_type(a.atttypid, a.atttypmod) INTO v_uid_type
        FROM pg_attribute a
        WHERE a.attrelid = 'public.users'::regclass AND a.attname = 'id';

        EXECUTE format($f$
            CREATE TABLE public.chat_mutes (
                id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id       %1$s NOT NULL
                    CONSTRAINT chat_mutes_user_id_fk
                    REFERENCES public.users (id) ON DELETE CASCADE,
                muted_user_id %1$s
                    CONSTRAINT chat_mutes_muted_user_id_fk
                    REFERENCES public.users (id) ON DELETE CASCADE,
                group_id      uuid
                    CONSTRAINT chat_mutes_group_id_fk
                    REFERENCES public.groups (id) ON DELETE CASCADE,
                muted_until   timestamptz,
                created_at    timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT chat_mutes_exactly_one_target_chk
                    CHECK ((muted_user_id IS NULL) <> (group_id IS NULL)),
                CONSTRAINT chat_mutes_not_self_chk
                    CHECK (muted_user_id IS NULL OR muted_user_id <> user_id)
            )$f$, v_uid_type);
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS chat_mutes_user_peer_uidx
    ON public.chat_mutes (user_id, muted_user_id) WHERE muted_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_mutes_user_group_uidx
    ON public.chat_mutes (user_id, group_id) WHERE group_id IS NOT NULL;

-- ── 4. rate_limit_counters ──────────────────────────────────
-- Fixed-window counters shared by every backend instance (the
-- current in-memory limiter in src/middleware/rate-limit.ts is
-- per-process only).
--   action  e.g. 'message_send', 'otp_request'
--   subject who is limited, e.g. a user id or phone hash
CREATE TABLE IF NOT EXISTS public.rate_limit_counters (
    action       varchar(64) NOT NULL,
    subject      text        NOT NULL,
    window_start timestamptz NOT NULL,
    window_end   timestamptz NOT NULL,
    count        integer     NOT NULL DEFAULT 0,
    CONSTRAINT rate_limit_counters_pk PRIMARY KEY (action, subject, window_start),
    CONSTRAINT rate_limit_counters_count_chk  CHECK (count >= 0),
    CONSTRAINT rate_limit_counters_window_chk CHECK (window_end > window_start)
);

CREATE INDEX IF NOT EXISTS rate_limit_counters_window_end_idx
    ON public.rate_limit_counters (window_end);

-- Atomically count one hit and return the new total for the current
-- window. Callers compare it with their limit (e.g. > 60 → 429).
-- Single INSERT ... ON CONFLICT, so concurrent requests can't race.
CREATE OR REPLACE FUNCTION public.rate_limit_hit(
    p_action         varchar,
    p_subject        text,
    p_window_seconds integer
)
RETURNS integer
LANGUAGE sql
AS $$
    INSERT INTO public.rate_limit_counters AS c (action, subject, window_start, window_end, count)
    VALUES (
        p_action,
        p_subject,
        to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds),
        to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds + p_window_seconds),
        1
    )
    ON CONFLICT (action, subject, window_start)
    DO UPDATE SET count = c.count + 1
    RETURNING count;
$$;

-- Expired windows are useless; delete them hourly.
CREATE OR REPLACE FUNCTION public.purge_rate_limit_counters()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_n integer;
BEGIN
    DELETE FROM public.rate_limit_counters WHERE window_end < now() - interval '1 hour';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;

-- Schedule only where pg_cron is installed (Supabase); same guard
-- style as migration 004.
-- Dynamic SQL so this block still parses on a DB without pg_cron.
DO $$
DECLARE
    v_exists boolean;
BEGIN
    IF to_regclass('cron.job') IS NOT NULL THEN
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = $1)'
            INTO v_exists USING 'purge-rate-limit-counters';
        IF NOT v_exists THEN
            EXECUTE $c$SELECT cron.schedule('purge-rate-limit-counters', '17 * * * *',
                                            'SELECT public.purge_rate_limit_counters();')$c$;
        END IF;
    END IF;
END
$$;

COMMIT;

-- ============================================================
-- Verification: run scripts/verify-db26.sql (rolls back, writes
-- nothing). It checks all eight §6.8 tables exist and that
-- sessions / dashboard_sessions are two separate tables.
-- ============================================================
