-- Add an encrypted (AES-256-GCM via vault key) copy of the recovery mnemonic
-- to profiles so it can be restored when the user's local IndexedDB is cleared.
-- The blob is identical in format to encrypted_private_key: base64(IV[12] + ciphertext).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS encrypted_mnemonic text DEFAULT NULL;

COMMENT ON COLUMN public.profiles.encrypted_mnemonic IS
  'AES-256-GCM encrypted BIP-39 mnemonic (encrypted with the vault key). '
  'Cloud backup so the user can restore the phrase after an IDB wipe.';
