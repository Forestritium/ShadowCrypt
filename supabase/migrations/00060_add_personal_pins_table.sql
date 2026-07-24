
CREATE TABLE IF NOT EXISTS public.personal_pins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid  NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id text  NOT NULL,
  message_id      text  NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, conversation_id, message_id)
);

ALTER TABLE public.personal_pins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_can_view_personal_pins" ON public.personal_pins;
CREATE POLICY "owner_can_view_personal_pins" ON public.personal_pins
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "owner_can_insert_personal_pins" ON public.personal_pins;
CREATE POLICY "owner_can_insert_personal_pins" ON public.personal_pins
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "owner_can_delete_personal_pins" ON public.personal_pins;
CREATE POLICY "owner_can_delete_personal_pins" ON public.personal_pins
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid());

ALTER PUBLICATION supabase_realtime ADD TABLE public.personal_pins;
