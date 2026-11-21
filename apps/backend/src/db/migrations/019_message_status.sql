-- ============================================================
-- 019_message_status.sql   (BE-5.5)
-- Run this in: Supabase -> SQL Editor -> New Query -> Run
--
-- Four-state message status (sent / delivered / read / failed).
--
-- WHY A NEW TABLE: pending_messages rows are hard-deleted once delivered
-- (Tech Arch S6.4), so they cannot remember "delivered" or "read" for the
-- sender. This table holds ONLY status metadata - no ciphertext, no
-- plaintext, no recipient device ids - one row per logical message,
-- aggregated across the recipient's devices ("any device escalates",
-- Tech Arch S9.4 / decision #2).
--
-- Rank: sent < delivered < read. Transitions only move UP, except:
--   failed -> sent       (sender retries, PRD 8.2)
--   failed -> delivered  (message actually arrived; truth wins)
--   failed -> read
-- Retention: every transition sets expires_at = now() + 30 days, so a
-- sender who was offline can still sync the outcome; a message that is
-- never delivered simply ages out with its queue row and the sender's
-- indicator stays green (Tech Arch S9.4 / decision #3).
--
-- Requires: 018 (client_message_id). Independent of 013's pending_messages
-- rename except for reading the table name in the comment below.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.message_status (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_device_id  uuid NOT NULL
        REFERENCES public.devices(id) ON DELETE CASCADE,
    sender_user_id    uuid NOT NULL,
    client_message_id uuid NOT NULL,
    recipient_user_id uuid NOT NULL,
    state             text NOT NULL DEFAULT 'sent',
    sent_at           timestamptz NOT NULL DEFAULT now(),
    delivered_at      timestamptz,
    read_at           timestamptz,
    failed_at         timestamptz,
    failure_reason    text,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz NOT NULL,
    CONSTRAINT message_status_state_check
        CHECK (state IN ('sent', 'delivered', 'read', 'failed')),
    CONSTRAINT message_status_failure_reason_check
        CHECK (failure_reason IS NULL OR state = 'failed'),
    CONSTRAINT message_status_sender_msg_uniq
        UNIQUE (sender_device_id, client_message_id)
);

-- Sender catch-up: "everything on my device changed since T".
CREATE INDEX IF NOT EXISTS idx_message_status_sender_updated
    ON public.message_status (sender_device_id, updated_at);

-- Cleanup scan.
CREATE INDEX IF NOT EXISTS idx_message_status_expires
    ON public.message_status (expires_at);

-- Authorization lookup for the recipient's read receipt.
CREATE INDEX IF NOT EXISTS idx_message_status_recipient
    ON public.message_status (recipient_user_id);

COMMENT ON TABLE public.message_status IS
    'BE-5.5: sender-visible status (sent/delivered/read/failed) per client_message_id. Metadata only - never ciphertext. Outlives the pending_messages row, which is deleted on delivery.';

-- Structural deletion, same posture as pending_messages: nothing lingers.
CREATE OR REPLACE FUNCTION public.cleanup_message_status()
RETURNS void
LANGUAGE sql
AS $$ DELETE FROM public.message_status WHERE expires_at < now(); $$;

-- Schedule alongside cleanup-pending-messages (013). Guarded so this
-- migration still succeeds where pg_cron is not installed.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-message-status') THEN
            PERFORM cron.unschedule('cleanup-message-status');
        END IF;
        PERFORM cron.schedule(
            'cleanup-message-status',
            '*/5 * * * *',
            'SELECT public.cleanup_message_status();'
        );
    END IF;
END
$$;

COMMIT;

-- ============================================================
-- ROLLBACK (manual "down"):
-- BEGIN;
-- DO $$
-- BEGIN
--     IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
--        AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-message-status') THEN
--         PERFORM cron.unschedule('cleanup-message-status');
--     END IF;
-- END $$;
-- DROP FUNCTION IF EXISTS public.cleanup_message_status();
-- DROP TABLE IF EXISTS public.message_status;
-- COMMIT;
-- ============================================================
