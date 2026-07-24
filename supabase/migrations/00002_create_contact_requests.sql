
-- Contact requests table
CREATE TABLE contact_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receiver_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sender_id, receiver_id)
);

-- Enable RLS
ALTER TABLE contact_requests ENABLE ROW LEVEL SECURITY;

-- Helper: sender can see their own outgoing requests
CREATE OR REPLACE FUNCTION can_view_contact_request(req_sender_id uuid, req_receiver_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT auth.uid() = req_sender_id OR auth.uid() = req_receiver_id;
$$;

-- Sender can insert a request to anyone
CREATE POLICY "sender_can_insert" ON contact_requests
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = sender_id);

-- Both sender and receiver can view the request
CREATE POLICY "parties_can_select" ON contact_requests
  FOR SELECT TO authenticated
  USING (can_view_contact_request(sender_id, receiver_id));

-- Only receiver can update status (accept/reject)
CREATE POLICY "receiver_can_update" ON contact_requests
  FOR UPDATE TO authenticated
  USING (auth.uid() = receiver_id)
  WITH CHECK (auth.uid() = receiver_id);

-- Sender can delete (cancel) their own pending request; receiver can delete after responding
CREATE POLICY "parties_can_delete" ON contact_requests
  FOR DELETE TO authenticated
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

-- Enable realtime for this table
ALTER PUBLICATION supabase_realtime ADD TABLE contact_requests;
