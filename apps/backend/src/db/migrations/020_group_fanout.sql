-- ============================================================
-- 020_group_fanout.sql   (BE-5.7)
-- Run this in: Supabase -> SQL Editor -> New Query -> Run
--
-- Group message fan-out. Two changes, both idempotent:
--
-- 1. message_status becomes one row PER RECIPIENT.
--    019 made (sender_device_id, client_message_id) unique, which only
--    works for 1:1 (one recipient). A group message has one status per
--    recipient member ("correct per-recipient status tracking"), so the
--    unique key gains recipient_user_id. A 1:1 message still has exactly
--    one row, so existing behaviour and data are unchanged.
--
-- 2. Enforce the 70-member group cap in the database (PRD 5.7 / 12.8:
--    "Cannot add a 71st member"). There is no add-member API in the
--    backend yet, so the cap is guaranteed at the data layer: any code
--    path that inserts into group_members is covered. The groups row is
--    locked first so two concurrent inserts cannot both pass the check.
--
-- Group queue rows need no schema change: pending_messages already
-- supports recipient_group_id (+ recipient_device_id NOT NULL, user NULL
-- by the user-XOR-group CHECK) and idx_pending_messages_recipient_group.
-- ============================================================

BEGIN;

-- ── 1. message_status: unique per recipient ───────────────────
ALTER TABLE public.message_status
    DROP CONSTRAINT IF EXISTS message_status_sender_msg_uniq;

ALTER TABLE public.message_status
    DROP CONSTRAINT IF EXISTS message_status_sender_msg_recipient_uniq;

ALTER TABLE public.message_status
    ADD CONSTRAINT message_status_sender_msg_recipient_uniq
    UNIQUE (sender_device_id, client_message_id, recipient_user_id);

-- ── 2. 70-member cap ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_group_member_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    member_count integer;
BEGIN
    -- Serialise concurrent adds to the same group.
    PERFORM 1 FROM public.groups WHERE id = NEW.group_id FOR UPDATE;

    SELECT count(*) INTO member_count
      FROM public.group_members
     WHERE group_id = NEW.group_id;

    IF member_count >= 70 THEN
        RAISE EXCEPTION 'GROUP_MEMBER_CAP: group % already has 70 members', NEW.group_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_members_enforce_cap ON public.group_members;
CREATE TRIGGER group_members_enforce_cap
    BEFORE INSERT ON public.group_members
    FOR EACH ROW EXECUTE FUNCTION public.enforce_group_member_cap();

COMMIT;

-- ============================================================
-- ROLLBACK (manual "down"):
-- BEGIN;
-- DROP TRIGGER IF EXISTS group_members_enforce_cap ON public.group_members;
-- DROP FUNCTION IF EXISTS public.enforce_group_member_cap();
-- -- Only safe while no message has more than one status row:
-- ALTER TABLE public.message_status
--     DROP CONSTRAINT IF EXISTS message_status_sender_msg_recipient_uniq;
-- ALTER TABLE public.message_status
--     ADD CONSTRAINT message_status_sender_msg_uniq
--     UNIQUE (sender_device_id, client_message_id);
-- COMMIT;
-- ============================================================
