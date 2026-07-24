
-- ── Fix: call_signals missing from supabase_realtime publication ───────────
--
-- Migration 00055 created the call_signals table but never added it to the
-- Supabase Realtime publication.  Without this, postgres_changes subscriptions
-- with event='INSERT' on call_signals are completely inert — the Realtime
-- server never emits the event, so the receiver's subscribeToSignals() handler
-- is never invoked and incoming calls never arrive.
--
-- REPLICA IDENTITY FULL is also required so that the Realtime event payload
-- contains the full row data (not just the primary key); without it the
-- payload.new object is empty and handleSignal cannot read type/from_user.

ALTER TABLE public.call_signals REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.call_signals;
