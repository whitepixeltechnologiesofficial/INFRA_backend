-- BE-6.1: defense-in-depth for the 27 Sep (Samson) decision — ONE
-- active Web session per account. routes/linking.ts already enforces
-- this transactionally (revoke-existing-web-row + insert-new-row in
-- the same transaction), but two different QR tokens scanned by two
-- phones at the same instant could otherwise race past that check
-- under READ COMMITTED. This index makes the DB itself reject it.
--
-- Mirrors the existing signed_prekeys_one_current_per_device_idx
-- pattern in 012_add_devices_signing_key.sql.sql (partial unique index
-- over the "current/active" rows only).

CREATE UNIQUE INDEX IF NOT EXISTS devices_one_active_web_per_user_idx
  ON devices (user_id)
  WHERE device_type = 'web' AND revoked_at IS NULL;
