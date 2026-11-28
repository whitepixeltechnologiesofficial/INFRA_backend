-- 013_sessions_refresh_rotation.sql
-- BE-R2.5 auth review: F4 (token_lookup uniqueness) + N3 (refresh rotation columns).
--
-- Safe to run against a database with existing sessions: nothing is deleted and no
-- session is invalidated. Legacy rows are backfilled so that they behave correctly
-- under the new reuse-detection logic.
--
-- PRE-FLIGHT (run these by hand first; the DO block below enforces the first two):
--   SELECT count(*) FROM sessions WHERE token_lookup IS NULL;
--   SELECT token_lookup, count(*) FROM sessions GROUP BY 1 HAVING count(*) > 1;
--
-- If the duplicate check reports rows, STOP. Do not delete them automatically —
-- deciding which session survives is an operator decision. `token_lookup` is the
-- first 32 hex chars of SHA-256 over a 384-bit random token, so a genuine collision
-- is cryptographically impossible; duplicates in practice mean corrupted or
-- hand-seeded data, and warrant inspection.

-- ─────────────────────────────────────────────────────────────────────────────
-- N3: rotation bookkeeping
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_family_id UUID;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS replaced_by_session_id UUID;

-- Backfill families for rows that predate rotation.
--
-- Grouping by (user_id, device_id) is deliberate: it matches the fallback scope in
-- refresh-token.ts, so a legacy device's sessions all belong to one family. That
-- means reuse detection on a legacy row revokes the whole set for that device
-- rather than a single row. Over-revoking is the safe direction for a security
-- control — it cannot leave a stolen token usable.
--
-- md5(...)::uuid derives a stable v4-shaped UUID from the pair, so re-running this
-- is idempotent and rows created by different sessions still land in one family.
UPDATE sessions
   SET token_family_id = md5(user_id || ':' || device_id)::uuid
 WHERE token_family_id IS NULL;

-- Foreign keys are added separately and NOT VALID: on a large table a validated FK
-- takes an ACCESS EXCLUSIVE lock and a full scan, which would block the live auth
-- path. These are self-referential integrity checks, and rotation writes them in
-- the same transaction, so validating later is acceptable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_replaced_by_fk'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_replaced_by_fk
      FOREIGN KEY (replaced_by_session_id) REFERENCES sessions(id) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sessions_token_family_idx ON sessions (token_family_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- F4: token_lookup must be NOT NULL UNIQUE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Why this matters for correctness, not just hygiene: validateRefreshToken and
-- rotateRefreshToken both resolve a token with
--   SELECT ... WHERE token_lookup = $1 LIMIT 1
-- A duplicate lookup key means that query can return either row. A client could
-- then be handed a session belonging to a different login, or a revoked session
-- could be shadowed by an active one. The index alone does not prevent this.

DO $$
DECLARE
  null_count   BIGINT;
  dup_count    BIGINT;
BEGIN
  SELECT count(*) INTO null_count FROM sessions WHERE token_lookup IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce NOT NULL: % session row(s) have a NULL token_lookup. '
      'A NULL lookup key can never be validated, so these rows are already dead. '
      'Inspect and remove them, then re-run.', null_count;
  END IF;

  SELECT count(*) INTO dup_count FROM (
    SELECT token_lookup FROM sessions GROUP BY token_lookup HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce UNIQUE: % duplicated token_lookup value(s) exist. '
      'Refusing to delete sessions automatically — decide which row to keep first.',
      dup_count;
  END IF;
END $$;

ALTER TABLE sessions ALTER COLUMN token_lookup SET NOT NULL;

-- The existing sessions_token_lookup_idx is a plain index; drop it first so the
-- UNIQUE constraint can create its own equivalent rather than leaving a redundant
-- pair on the hot path.
DROP INDEX IF EXISTS sessions_token_lookup_idx;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_token_lookup_key UNIQUE (token_lookup);

-- ─────────────────────────────────────────────────────────────────────────────
-- F5: dashboard_admins.email must be UNIQUE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- routes/admin.ts resolves a login with
--   SELECT ... FROM dashboard_admins WHERE email = $1 LIMIT 1
-- Without a unique constraint, two rows sharing an email make that query return
-- an arbitrary one of them, so which administrator authenticates is
-- non-deterministic and depends on physical row order. `role` is likewise
-- unconstrained free text, so an unexpected role string is accepted silently.
--
-- The email constraint is added here; role normalisation is left to the owner
-- because choosing an allowed set is a product decision.

DO $$
DECLARE
  dup_count BIGINT;
BEGIN
  -- Skip cleanly if the table is absent: dashboard_admins predates this
  -- migration set and is not created by any migration in this directory.
  IF to_regclass('public.dashboard_admins') IS NULL THEN
    RAISE NOTICE 'dashboard_admins not present; skipping F5 email constraint.';
    RETURN;
  END IF;

  SELECT count(*) INTO dup_count FROM (
    SELECT lower(btrim(email)) FROM public.dashboard_admins
     GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce UNIQUE on dashboard_admins.email: % duplicated value(s) exist. '
      'Login resolves by email with LIMIT 1, so duplicates make the matched admin '
      'non-deterministic. De-duplicate first.', dup_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dashboard_admins_email_key'
  ) THEN
    ALTER TABLE public.dashboard_admins
      ADD CONSTRAINT dashboard_admins_email_key UNIQUE (email);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- NOT included: OTP re-hashing
-- ─────────────────────────────────────────────────────────────────────────────
-- otp_verifications.code_hash and sms_outbox.otp_hash currently hold unsalted
-- SHA-256 (and, for rows backfilled by migration 003, md5 of the message body).
-- The application now writes HMAC-SHA256, so newly issued OTPs are safe. Existing
-- rows are deliberately left alone: OTP_TTL is 5 minutes, so anything still stored
-- has long expired, and there is no way to recompute a correct HMAC from a
-- truncated SHA-256 digest. Re-hashing is not possible and not necessary.
