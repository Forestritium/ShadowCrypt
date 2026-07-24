DROP POLICY IF EXISTS "Users can insert relay messages" ON relay_messages;

CREATE POLICY "Users can insert relay messages" ON relay_messages
  FOR INSERT TO authenticated 
  WITH CHECK (
    auth.uid() = sender_id 
    AND (
      recipient_id = sender_id 
      OR (
        EXISTS (
          SELECT 1 FROM public.contacts 
          WHERE owner_id = sender_id AND contact_id = recipient_id
        )
        AND EXISTS (
          SELECT 1 FROM public.contacts 
          WHERE owner_id = recipient_id AND contact_id = sender_id
        )
      )
    )
  );
