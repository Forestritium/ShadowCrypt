
-- Device identity recovery: store an encrypted copy of the device key pair in
-- Supabase so that clearing localStorage does not create a ghost device row.
--
-- The blob is AES-256-GCM encrypted with the user's vault key (same pattern as
-- encrypted_private_key in profiles). Supabase stores an opaque ciphertext it
-- cannot open; only the correct password reproduces the vault key that decrypts it.
ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS encrypted_device_keypair TEXT DEFAULT NULL;

COMMENT ON COLUMN public.user_devices.encrypted_device_keypair IS
  'AES-256-GCM encrypted device key pair (encrypted with the vault key). '
  'Allows recovery of the stable device_id after localStorage is cleared '
  'without registering a duplicate device row. Format: base64(IV[12] + ciphertext).';
