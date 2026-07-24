
-- ── CONTACTS TABLE ────────────────────────────────────────────────────────────
CREATE TABLE public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  username text NOT NULL,
  public_key text NOT NULL,
  fingerprint text NOT NULL,
  conversation_id text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, contact_id)
);

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own contacts" ON public.contacts
  FOR SELECT TO authenticated USING (auth.uid() = owner_id);

CREATE POLICY "Users can insert their own contacts" ON public.contacts
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can update their own contacts" ON public.contacts
  FOR UPDATE TO authenticated USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can delete their own contacts" ON public.contacts
  FOR DELETE TO authenticated USING (auth.uid() = owner_id);

-- ── MESSAGES TABLE ────────────────────────────────────────────────────────────
-- Each user stores their own copy of messages they send or receive.
-- Protected by RLS: only the owner can read their own messages.
CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL,
  sender_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content text NOT NULL,
  sender_username text NOT NULL,
  is_own boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own message copies" ON public.messages
  FOR SELECT TO authenticated USING (auth.uid() = owner_id);

CREATE POLICY "Users can insert their own message copies" ON public.messages
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can delete their own message copies" ON public.messages
  FOR DELETE TO authenticated USING (auth.uid() = owner_id);

-- Index for fast conversation lookups
CREATE INDEX idx_messages_owner_conversation ON public.messages(owner_id, conversation_id, created_at);
CREATE INDEX idx_contacts_owner ON public.contacts(owner_id);

-- Enable Realtime for messages
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.contacts;
