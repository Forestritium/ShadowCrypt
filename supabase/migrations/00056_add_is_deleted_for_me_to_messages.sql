
-- Flag for "delete for me" — visible only to the row owner, the other party
-- is unaffected.  Defaults to false so existing rows keep their current state.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS is_deleted_for_me boolean NOT NULL DEFAULT false;
