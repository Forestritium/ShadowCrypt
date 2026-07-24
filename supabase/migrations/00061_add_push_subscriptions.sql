
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  device_id   text,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_can_view_push_subscriptions" ON public.push_subscriptions;
CREATE POLICY "owner_can_view_push_subscriptions" ON public.push_subscriptions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "owner_can_upsert_push_subscriptions" ON public.push_subscriptions;
CREATE POLICY "owner_can_upsert_push_subscriptions" ON public.push_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "owner_can_update_push_subscriptions" ON public.push_subscriptions;
CREATE POLICY "owner_can_update_push_subscriptions" ON public.push_subscriptions
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "owner_can_delete_push_subscriptions" ON public.push_subscriptions;
CREATE POLICY "owner_can_delete_push_subscriptions" ON public.push_subscriptions
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());
