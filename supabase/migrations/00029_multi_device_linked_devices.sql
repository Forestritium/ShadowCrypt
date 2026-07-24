
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 00029: Multi-device linked-device support
--
-- Adds:
--   1. user_devices table — one row per registered device per user
--   2. sender_device_id / recipient_device_id columns on relay_messages
--      (nullable for backward compat with single-device messages)
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. user_devices ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_devices (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id          TEXT        NOT NULL,          -- stable client-side UUID (localStorage)
  device_name        TEXT        NOT NULL DEFAULT 'Unknown Device',
  public_key         TEXT        NOT NULL,          -- base64 X25519 public key for this device
  is_primary         BOOLEAN     NOT NULL DEFAULT FALSE,
  approved           BOOLEAN     NOT NULL DEFAULT FALSE, -- primary must approve secondary devices
  approval_signature TEXT,                          -- reserved for future HMAC approval proof
  added_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, device_id)
);

-- Index for fast per-user device lookups
CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON public.user_devices(user_id);

-- ─── RLS for user_devices ────────────────────────────────────────────────────

ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;

-- Users can see all APPROVED devices for any user they interact with
-- (needed so senders can fetch recipient device keys before encrypting)
CREATE POLICY "devices_select"
  ON public.user_devices
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (approved = TRUE OR user_id = auth.uid())
  );

-- Users can only insert their own device rows
CREATE POLICY "devices_insert"
  ON public.user_devices
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Users can update their own devices; approval can only be set by the device owner
CREATE POLICY "devices_update"
  ON public.user_devices
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Users can delete their own devices (de-register)
CREATE POLICY "devices_delete"
  ON public.user_devices
  FOR DELETE
  USING (user_id = auth.uid());

-- ─── Realtime for device approval notifications ───────────────────────────────

ALTER PUBLICATION supabase_realtime ADD TABLE public.user_devices;

-- ─── 2. relay_messages: add device columns ────────────────────────────────────

ALTER TABLE public.relay_messages
  ADD COLUMN IF NOT EXISTS sender_device_id    TEXT,
  ADD COLUMN IF NOT EXISTS recipient_device_id TEXT;

-- Index for device-specific filtering (used by multi-device subscriptions)
CREATE INDEX IF NOT EXISTS idx_relay_sender_device
  ON public.relay_messages(sender_device_id)
  WHERE sender_device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_relay_recipient_device
  ON public.relay_messages(recipient_device_id)
  WHERE recipient_device_id IS NOT NULL;
