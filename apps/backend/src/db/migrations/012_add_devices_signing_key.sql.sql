-- BE-5.2: prekey distribution tables for X3DH.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS signing_public_key text;

CREATE TABLE IF NOT EXISTS signed_prekeys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  public_key  text NOT NULL,
  signature   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  replaced_at timestamptz
);

CREATE INDEX IF NOT EXISTS signed_prekeys_device_id_idx
  ON signed_prekeys (device_id);

-- Only one current (not replaced) signed prekey per device.
CREATE UNIQUE INDEX IF NOT EXISTS signed_prekeys_one_current_per_device_idx
  ON signed_prekeys (device_id) WHERE replaced_at IS NULL;

CREATE TABLE IF NOT EXISTS one_time_prekeys (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  public_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz
);

CREATE INDEX IF NOT EXISTS one_time_prekeys_device_claimed_idx
  ON one_time_prekeys (device_id, claimed_at);

CREATE UNIQUE INDEX IF NOT EXISTS one_time_prekeys_device_key_idx
  ON one_time_prekeys (device_id, public_key);