
-- ── call_signals: WebRTC signaling relay ─────────────────────────────────────
-- Stores short-lived offer/answer/ICE/control frames for the WebRTC voice-call
-- feature.  Rows are deleted by the client immediately after consumption so the
-- table stays small.

CREATE TABLE IF NOT EXISTS public.call_signals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  to_user     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Types: 'offer' | 'answer' | 'ice-candidate' | 'hangup' | 'reject' | 'busy' | 'ringing'
  type        text NOT NULL,
  payload     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.call_signals ENABLE ROW LEVEL SECURITY;

-- Callers can INSERT signals addressed to anyone (the receiver's RLS controls reads).
CREATE POLICY "call_signals_insert" ON public.call_signals
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = from_user);

-- Each user can only read signals addressed to them.
CREATE POLICY "call_signals_select" ON public.call_signals
  FOR SELECT TO authenticated
  USING (auth.uid() = to_user);

-- Each user can delete signals they sent (cleanup after hangup) or received.
CREATE POLICY "call_signals_delete" ON public.call_signals
  FOR DELETE TO authenticated
  USING (auth.uid() = from_user OR auth.uid() = to_user);

-- Auto-expire stale signals after 2 minutes to prevent table growth when a
-- client crashes without cleaning up.
CREATE INDEX IF NOT EXISTS call_signals_created_at_idx ON public.call_signals (created_at);

-- ── profiles: calls_disabled flag ────────────────────────────────────────────
-- When TRUE the caller is shown "user is offline / not available for calls".
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS calls_disabled boolean NOT NULL DEFAULT false;
