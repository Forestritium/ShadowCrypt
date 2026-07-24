CREATE POLICY "Users can view their own sent relay messages" ON relay_messages
  FOR SELECT TO authenticated
  USING (sender_id = auth.uid());
