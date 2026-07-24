
-- ── Add composite unique constraint (id, owner_id) ────────────────────────────
-- Previously `id` alone was the PK, which made every user's copy of a shared
-- message conflict on the same UUID.  With v328 both sender and receiver store
-- messages under the same sharedMsgId; we need a per-owner unique slot so each
-- user can upsert their own row without touching the other's.
ALTER TABLE public.messages
  ADD CONSTRAINT messages_id_owner_unique UNIQUE (id, owner_id);

-- ── Add UPDATE policy (was missing entirely) ──────────────────────────────────
-- Without this, upsert fallback-to-UPDATE and direct UPDATEs (edit content,
-- mark deleted-for-everyone) all fail with a 403 RLS error.
CREATE POLICY "Users can update their own message copies" ON public.messages
  FOR UPDATE TO authenticated
  USING  (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);
