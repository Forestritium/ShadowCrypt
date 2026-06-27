
-- Remove the public-read policy on chat-images and flip the bucket to private.
-- Images are AES-256-GCM ciphertexts so the plaintext is safe, but:
--   (a) unauthenticated actors should not be able to enumerate/fetch blobs,
--   (b) consistency: private bucket + signed URLs is the correct posture for
--       any content that isn't intentionally public-facing.
-- Access is now: owner uploads, authenticated users (both parties in a
-- conversation) read via short-lived signed URLs created in relay.ts.

-- 1. Drop the old blanket public-read policy
DROP POLICY IF EXISTS "Public read chat images" ON storage.objects;

-- 2. Mark the bucket private (public = false)
UPDATE storage.buckets
  SET public = false
WHERE id = 'chat-images';

-- 3. Add authenticated-only read policy (signed URL generation remains
--    available to both sender and recipient through the service role path;
--    this policy covers direct SELECT access for authenticated sessions)
CREATE POLICY "Authenticated users read chat images"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'chat-images');
