-- ============================================================
-- 018_pending_messages_idempotency.sql   (BE-5.4)
-- Run this in: Supabase -> SQL Editor -> New Query -> Run
--
-- Adds client_message_id so a client retry of POST /relay/send can never
-- create a duplicate row. Scoped per (sender device, recipient device):
-- one send fans out to N rows that all share the same client_message_id.
-- Nullable so existing rows (and DB-2.2-V test rows) are untouched.
-- ============================================================

ALTER TABLE public.pending_messages
    ADD COLUMN IF NOT EXISTS client_message_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS pending_messages_client_msg_uniq_idx
    ON public.pending_messages (sender_device_id, recipient_device_id, client_message_id)
    WHERE client_message_id IS NOT NULL;

-- ROLLBACK:
-- DROP INDEX IF EXISTS public.pending_messages_client_msg_uniq_idx;
-- ALTER TABLE public.pending_messages DROP COLUMN IF EXISTS client_message_id;
