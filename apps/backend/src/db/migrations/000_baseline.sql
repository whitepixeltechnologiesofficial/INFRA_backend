-- ============================================================
-- 000_baseline.sql
-- The database as it was BEFORE migration 002.
-- The live Supabase database was first built by hand, so no migration
-- ever created these tables. This file creates them, so that the whole
-- database can be rebuilt from an EMPTY Postgres by running every
-- migration in order (000, 002, 003, ...).

-- Columns that a later migration adds (for example sms_outbox.otp_hash
-- in 003) are deliberately NOT here: the later migration adds them.
-- users.id is uuid, exactly like the live database (see 008).
-- Safe to run twice: everything uses IF NOT EXISTS.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Types ────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'device_type') THEN
        CREATE TYPE public.device_type AS ENUM ('phone', 'web');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'platform') THEN
        CREATE TYPE public.platform AS ENUM ('android', 'ios', 'web');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_status') THEN
        CREATE TYPE public.report_status AS ENUM ('pending', 'reviewed', 'actioned', 'dismissed');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'audit_action') THEN
        CREATE TYPE public.audit_action AS ENUM ('warn', 'restrict', 'ban', 'dismiss');
    END IF;
END $$;

-- ── users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number varchar(20)  NOT NULL,
    name         varchar(100) NOT NULL DEFAULT '',
    created_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_number_unique ON public.users (phone_number);
CREATE INDEX IF NOT EXISTS users_phone_number_idx ON public.users (phone_number);

-- ── devices ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.devices (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL,
    device_type         public.device_type NOT NULL,
    platform            public.platform NOT NULL,
    identity_public_key text NOT NULL,
    is_active           boolean NOT NULL DEFAULT true,
    linked_at           timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz,
    revoked_at          timestamptz
);
CREATE INDEX IF NOT EXISTS devices_user_id_idx ON public.devices (user_id);

-- ── sessions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sessions (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  varchar(64) NOT NULL,
    device_id                varchar(64) NOT NULL,
    token_lookup             varchar(32),
    refresh_token_hash       varchar(60) NOT NULL,
    refresh_token_expires_at timestamptz NOT NULL,
    revoked_at               timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON public.sessions (user_id);

-- ── otp_verifications ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.otp_verifications (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number varchar(20) NOT NULL,
    code_hash    text NOT NULL,
    attempts     integer NOT NULL DEFAULT 0,
    expires_at   timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    locked_until timestamptz,
    sent_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_verifications_phone_number_idx ON public.otp_verifications (phone_number);
CREATE INDEX IF NOT EXISTS otp_verifications_sent_at_idx ON public.otp_verifications (sent_at);

-- ── sms_outbox (003 replaces message with otp_hash) ────────────────────
CREATE TABLE IF NOT EXISTS public.sms_outbox (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number varchar(20) NOT NULL,
    message      text NOT NULL,              -- raw text; 003 replaces it with otp_hash
    status       varchar(20) NOT NULL DEFAULT 'pending',
    attempts     integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    sent_at      timestamptz
);
CREATE INDEX IF NOT EXISTS sms_outbox_status_idx ON public.sms_outbox (status);
CREATE INDEX IF NOT EXISTS sms_outbox_created_at_idx ON public.sms_outbox (created_at);

-- ── legal_acceptances ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.legal_acceptances (
    phone_number  varchar(20) PRIMARY KEY,
    legal_version varchar(64) NOT NULL,
    accepted_at   timestamptz NOT NULL DEFAULT now()
);

-- ── dashboard_admins ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.dashboard_admins (
    id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email                        varchar(256) NOT NULL,
    password_hash                text NOT NULL,
    role                         varchar(32) NOT NULL DEFAULT 'admin',
    is_test_account              boolean NOT NULL DEFAULT false,
    owner_reset_token_hash       text,
    owner_reset_token_expires_at timestamptz,
    created_at                   timestamptz NOT NULL DEFAULT now(),
    updated_at                   timestamptz NOT NULL DEFAULT now()
);

-- ── blocks ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.blocks (
    blocker_phone_hash text NOT NULL,
    blocked_phone_hash text NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT blocks_blocker_phone_hash_blocked_phone_hash_pk
    PRIMARY KEY (blocker_phone_hash, blocked_phone_hash)
);

-- ── reports (+ test_reports, same shape) ─────────────────────
-- reason_category, reported_group_id, evidence_expires_at are added by 015.
CREATE TABLE IF NOT EXISTS public.reports (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_phone_hash text NOT NULL,
    reported_phone_hash text NOT NULL,
    status              public.report_status NOT NULL DEFAULT 'pending',
    created_at          timestamptz NOT NULL DEFAULT now(),
    reviewed_at         timestamptz,
    actioned_at         timestamptz
);
CREATE INDEX IF NOT EXISTS reports_reporter_phone_hash_idx ON public.reports (reporter_phone_hash);
CREATE INDEX IF NOT EXISTS reports_reported_phone_hash_idx ON public.reports (reported_phone_hash);
CREATE INDEX IF NOT EXISTS reports_status_idx ON public.reports (status);

CREATE TABLE IF NOT EXISTS public.test_reports (LIKE public.reports INCLUDING ALL);

-- ── report_evidence (+ test_report_evidence) ─────────────────
-- decrypted_message_snapshot (005), purged_at/media_path (009),
-- metadata_snapshot (014), media_bucket (016) are added later.
CREATE TABLE IF NOT EXISTS public.report_evidence (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id          uuid NOT NULL REFERENCES public.reports (id) ON DELETE CASCADE,
    message_content    text NOT NULL,
    message_created_at timestamptz NOT NULL,
    captured_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_report_evidence_report_id ON public.report_evidence (report_id);

CREATE TABLE IF NOT EXISTS public.test_report_evidence (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    test_report_id     uuid NOT NULL REFERENCES public.test_reports (id) ON DELETE CASCADE,
    message_content    text NOT NULL,
    message_created_at timestamptz NOT NULL,
    captured_at        timestamptz NOT NULL DEFAULT now()
);

-- ── audit_log (old shape; 005 renames/replaces these columns) ─
CREATE TABLE IF NOT EXISTS public.audit_log (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id          uuid,
    target_phone_hash text,
    action            public.audit_action NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);
