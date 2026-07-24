-- Fix S-C1: Restrict storage reads to sender and recipient
DROP POLICY IF EXISTS "Authenticated users read chat images" ON storage.objects;
CREATE POLICY "Authenticated users read chat images"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'chat-images' AND
    auth.role() = 'authenticated' AND
    (
      (auth.uid()::text = (string_to_array(name, '/'))[1]) OR
      EXISTS (
        SELECT 1 FROM messages m WHERE m.owner_id = auth.uid() AND m.sender_id::text = (string_to_array(name, '/'))[1]
      ) OR
      EXISTS (
        SELECT 1 FROM relay_messages r WHERE r.recipient_id = auth.uid() AND r.sender_id::text = (string_to_array(name, '/'))[1]
      )
    )
  );

DROP POLICY IF EXISTS "Users read own voices" ON storage.objects;
CREATE POLICY "Users read own voices"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'chat-voices' AND
    auth.role() = 'authenticated' AND
    (
      (auth.uid()::text = (string_to_array(name, '/'))[1]) OR
      EXISTS (
        SELECT 1 FROM messages m WHERE m.owner_id = auth.uid() AND m.sender_id::text = (string_to_array(name, '/'))[1]
      ) OR
      EXISTS (
        SELECT 1 FROM relay_messages r WHERE r.recipient_id = auth.uid() AND r.sender_id::text = (string_to_array(name, '/'))[1]
      )
    )
  );

DROP POLICY IF EXISTS "Users read own files" ON storage.objects;
CREATE POLICY "Users read own files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'chat-files' AND
    auth.role() = 'authenticated' AND
    (
      (auth.uid()::text = (string_to_array(name, '/'))[1]) OR
      EXISTS (
        SELECT 1 FROM messages m WHERE m.owner_id = auth.uid() AND m.sender_id::text = (string_to_array(name, '/'))[1]
      ) OR
      EXISTS (
        SELECT 1 FROM relay_messages r WHERE r.recipient_id = auth.uid() AND r.sender_id::text = (string_to_array(name, '/'))[1]
      )
    )
  );
