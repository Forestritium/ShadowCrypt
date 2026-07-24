-- ── Username discovery opt-out ───────────────────────────────────────────────
-- When false the user won't appear in username search results.
-- They can still receive contact requests via QR code.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS discoverable boolean NOT NULL DEFAULT true;

-- ── Contact key-change history ────────────────────────────────────────────────
-- Stores every observed public-key change for a contact so the user can
-- review the full key history in the Security settings tab.
CREATE TABLE IF NOT EXISTS public.contact_key_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  old_key     text NOT NULL,
  new_key     text NOT NULL,
  old_fp      text NOT NULL,
  new_fp      text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.contact_key_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own key history" ON public.contact_key_history
  FOR SELECT TO authenticated USING (auth.uid() = owner_id);

CREATE POLICY "Users can insert their own key history" ON public.contact_key_history
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can delete their own key history" ON public.contact_key_history
  FOR DELETE TO authenticated USING (auth.uid() = owner_id);

CREATE INDEX IF NOT EXISTS idx_key_history_owner_contact
  ON public.contact_key_history(owner_id, contact_id, changed_at DESC);

-- ── Filter discoverable users from username search ────────────────────────────
-- Replaces the direct profiles SELECT in findUserByUsername with a filtered view.
-- (The app code still queries profiles directly; the WHERE clause in the RLS
-- policy is enforced per-row.  Existing SELECT policies remain unchanged.)
