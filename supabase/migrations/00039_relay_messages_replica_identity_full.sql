-- Supabase Realtime postgres_changes with a column filter
-- (filter: 'recipient_id=eq.${userId}') requires either:
--   (a) the filter column is part of the primary key, OR
--   (b) the table has REPLICA IDENTITY FULL.
-- Since recipient_id is not the PK of relay_messages, without FULL identity
-- the Supabase Realtime server cannot reliably apply the column filter and
-- may silently drop events or broadcast them to the wrong subscribers.
ALTER TABLE public.relay_messages REPLICA IDENTITY FULL;

-- Also add an index on recipient_id for efficient Realtime filter evaluation
-- (if not already present from a prior migration).
CREATE INDEX IF NOT EXISTS idx_relay_messages_recipient_id
  ON public.relay_messages (recipient_id);