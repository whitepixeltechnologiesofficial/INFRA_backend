-- PERM-2.5: device push tokens for backgrounded message alerts.
--
-- One row per (device, token). The token is an Expo push token
-- (ExponentPushToken[...]) that Expo's push service maps to FCM/APNs.
-- Rows are owned by a device, so revoking or deleting a device drops
-- its token and the backend can never alert a logged-out phone.

CREATE TABLE IF NOT EXISTS push_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token       text NOT NULL,
  platform    text NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_tokens_token_unique UNIQUE (token),
  CONSTRAINT push_tokens_device_unique UNIQUE (device_id)
);

CREATE INDEX IF NOT EXISTS push_tokens_user_id_idx ON push_tokens (user_id);
