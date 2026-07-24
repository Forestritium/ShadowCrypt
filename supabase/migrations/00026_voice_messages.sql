
-- ─── Storage bucket for voice messages ────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-voices',
  'chat-voices',
  false,
  20971520,  -- 20 MB per file (10-min Opus @ ~32 kbps ≈ 2.4 MB, well under limit)
  ARRAY['application/octet-stream']
)
ON CONFLICT (id) DO NOTHING;

-- Authenticated users can upload to their own folder
CREATE POLICY "Users upload own voices" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-voices' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Users can read voice files (signed URLs used for access)
CREATE POLICY "Users read own voices" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'chat-voices');

-- Users can delete their own voice files
CREATE POLICY "Users delete own voices" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'chat-voices' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ─── Daily voice send duration rate-limit table ────────────────────────────────
-- Tracks total seconds of voice messages sent per user per UTC day.
-- 600 seconds (10 minutes) is the daily cap.
CREATE TABLE public.voice_send_durations (
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  send_date  date        NOT NULL DEFAULT CURRENT_DATE,
  seconds    int         NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, send_date)
);

ALTER TABLE public.voice_send_durations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own voice duration" ON public.voice_send_durations
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "Users upsert own voice duration" ON public.voice_send_durations
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users update own voice duration" ON public.voice_send_durations
  FOR UPDATE TO authenticated USING (user_id = auth.uid());

-- ─── RPC: get today's total voice seconds ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_voice_send_duration(p_user_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_seconds int;
BEGIN
  SELECT seconds INTO v_seconds
  FROM public.voice_send_durations
  WHERE user_id = p_user_id AND send_date = CURRENT_DATE;
  RETURN COALESCE(v_seconds, 0);
END;
$$;

-- ─── RPC: atomically add seconds, return new total ────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_voice_send_duration(p_user_id uuid, p_seconds int)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_seconds int;
BEGIN
  INSERT INTO public.voice_send_durations (user_id, send_date, seconds)
    VALUES (p_user_id, CURRENT_DATE, p_seconds)
  ON CONFLICT (user_id, send_date) DO UPDATE
    SET seconds = voice_send_durations.seconds + p_seconds
  RETURNING seconds INTO v_seconds;
  RETURN v_seconds;
END;
$$;

-- ─── Voice columns on messages table ──────────────────────────────────────────
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS voice_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS voice_key_b64 TEXT,
  ADD COLUMN IF NOT EXISTS voice_duration_seconds INT;
