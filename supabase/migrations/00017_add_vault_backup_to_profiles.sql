-- vault_salt: raw PBKDF2 salt (base64), not sensitive, needed to re-derive the vault key on any device
-- encrypted_private_key: the AES-GCM encrypted identity key pair blob (same format as stored in IndexedDB)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS vault_salt text,
  ADD COLUMN IF NOT EXISTS encrypted_private_key text;