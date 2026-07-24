DROP POLICY IF EXISTS "Authenticated users read chat images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users read chat voices" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users read chat files" ON storage.objects;

CREATE POLICY "Users and contacts can read chat media" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id IN ('chat-images', 'chat-voices', 'chat-files')
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.contacts 
        WHERE owner_id = auth.uid() 
        AND contact_id::text = (storage.foldername(name))[1]
      )
    )
  );
