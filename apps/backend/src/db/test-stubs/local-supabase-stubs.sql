-- ============================================================
-- local-supabase-stubs.sql   (Local Supabase test stubs)
--
-- Minimal stubs for running backend migrations/tests against a
-- dedicated empty local PostgreSQL database that emulates the
-- Supabase environment. Only the required roles, extensions,
-- storage schema/tables and app-required tables are created.
--
-- Provided (requirement 5):
--   - Roles: anon, authenticated, service_role
--   - Extensions: pgcrypto (and uuid-ossp where referenced)
--   - Storage: storage schema + required storage tables
--   - Required tables: storage buckets/objects
--
-- The application's own tables are created by the migration chain
-- (000_baseline + subsequent migrations); this stub only provides
-- the Supabase environment primitives those migrations may reference.
-- ============================================================

-- Supabase-style API roles (used by RLS / JWT role resolution)
DO $$
BEGIN
  CREATE ROLE anon;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE ROLE authenticated;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE ROLE service_role;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT service_role TO postgres;

-- Required extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Storage schema (Supabase storage)
CREATE SCHEMA IF NOT EXISTS storage;

-- Required storage tables
CREATE TABLE IF NOT EXISTS storage.buckets (
  id            text PRIMARY KEY,
  name          text UNIQUE NOT NULL,
  owner         uuid,
  created_at    timestamptz DEFAULT now() NOT NULL,
  updated_at    timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id     text NOT NULL REFERENCES storage.buckets(id) ON DELETE CASCADE,
  name          text NOT NULL,
  owner         uuid,
  created_at    timestamptz DEFAULT now() NOT NULL,
  updated_at    timestamptz DEFAULT now() NOT NULL
);

-- Grant usage/select so the app roles can access storage in tests
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA storage TO anon, authenticated, service_role;
