-- The chat-images bucket stores AES-256-GCM ciphertext blobs, not raw image
-- files, so the content-type is always application/octet-stream.
-- The original MIME whitelist only allowed image/* types, which caused every
-- upload to be rejected by Supabase Storage's MIME-type guard.
-- Update the bucket to accept the encrypted blob content type.
UPDATE storage.buckets
  SET allowed_mime_types = ARRAY[
    'application/octet-stream',
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic'
  ]
WHERE id = 'chat-images';