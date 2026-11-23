-- 022 — DB-2.1: make main's users table match Architecture §6.1.
--
-- Report (Sprints 1–3, 13 Nov 2026): "On main, the users table differs:
-- text id instead of UUID, and no account_status."
--
--   1. users.id is uuid with a gen_random_uuid() default.
--      The live Supabase DB already uses uuid (see 008), so there this step
--      is a no-op. A database built from the old migrate-users.ts DDL
--      (varchar(64)) is converted in place: every foreign key that points at
--      users.id is dropped, its column converted to uuid, and re-created.
--      If any existing id is not a UUID the migration stops with a clear
--      error instead of corrupting data.
--   2. account_status enum (active | warned | restricted | banned) and a
--      NOT NULL users.account_status column defaulting to 'active', indexed.
--      Compatible with an enum created earlier by another branch (same labels,
--      any order): it is reused, and any missing label is added.
--
-- Idempotent: safe to re-run.

DO $$
DECLARE
  id_type   text;
  bad_ids   bigint;
  fk        record;
  fks       jsonb := '[]'::jsonb;
  item      jsonb;
  col_type  text;
BEGIN
  SELECT data_type INTO id_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id';

  IF id_type IS NULL THEN
    RAISE EXCEPTION 'DB-2.1: public.users.id not found';
  END IF;

  IF id_type <> 'uuid' THEN
    EXECUTE $q$
      SELECT count(*) FROM public.users
      WHERE id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    $q$ INTO bad_ids;
    IF bad_ids > 0 THEN
      RAISE EXCEPTION 'DB-2.1: % users.id value(s) are not UUIDs; fix them before converting', bad_ids;
    END IF;

    FOR fk IN
      SELECT c.conname,
             c.conrelid::regclass::text AS tbl,
             a.attname AS col,
             pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f'
        AND c.confrelid = 'public.users'::regclass
        AND array_length(c.conkey, 1) = 1
    LOOP
      fks := fks || jsonb_build_object('conname', fk.conname, 'tbl', fk.tbl, 'col', fk.col, 'def', fk.def);
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
    END LOOP;

    ALTER TABLE public.users ALTER COLUMN id TYPE uuid USING id::uuid;

    FOR item IN SELECT * FROM jsonb_array_elements(fks)
    LOOP
      SELECT format_type(a.atttypid, a.atttypmod) INTO col_type
      FROM pg_attribute a
      WHERE a.attrelid = (item->>'tbl')::regclass AND a.attname = item->>'col';
      IF col_type <> 'uuid' THEN
        EXECUTE format('ALTER TABLE %s ALTER COLUMN %I TYPE uuid USING %I::uuid',
                       item->>'tbl', item->>'col', item->>'col');
      END IF;
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',
                     item->>'tbl', item->>'conname', item->>'def');
    END LOOP;
  END IF;
END $$;

ALTER TABLE public.users ALTER COLUMN id SET DEFAULT gen_random_uuid();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'account_status' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.account_status AS ENUM ('active', 'warned', 'restricted', 'banned');
  END IF;
END $$;

ALTER TYPE public.account_status ADD VALUE IF NOT EXISTS 'active';
ALTER TYPE public.account_status ADD VALUE IF NOT EXISTS 'warned';
ALTER TYPE public.account_status ADD VALUE IF NOT EXISTS 'restricted';
ALTER TYPE public.account_status ADD VALUE IF NOT EXISTS 'banned';

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS account_status public.account_status NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS users_account_status_idx ON public.users (account_status);
