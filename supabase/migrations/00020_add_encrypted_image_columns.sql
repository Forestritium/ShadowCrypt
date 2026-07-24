
-- Add client-side-encrypted image storage columns to messages.
-- image_storage_path: path in the chat-images bucket (ciphertext blob)
-- image_key_b64:      base64 AES-256-GCM key (travels inside Double Ratchet ciphertext, stored here for DB copy)
-- Both columns are nullable: NULL means the row predates encrypted-image support (may still have image_url for legacy).

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS image_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS image_key_b64 TEXT;

-- reply_to equivalent (for the quoted reply thumbnail)
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS reply_to_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS reply_to_image_key TEXT;
