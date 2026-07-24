
-- ─── Storage bucket for chat images ───────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-images',
  'chat-images',
  true,
  10485760,  -- 10 MB per file
  ARRAY['image/jpeg','image/png','image/gif','image/webp','image/heic']
)
ON CONFLICT (id) DO NOTHING;

-- Authenticated users can upload to their own folder
CREATE POLICY "Users upload own images" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-images' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Anyone can read public images (URLs are unguessable UUIDs)
CREATE POLICY "Public read chat images" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'chat-images');

-- Users can delete their own images
CREATE POLICY "Users delete own images" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'chat-images' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ─── Daily image send rate-limit table ────────────────────────────────────────
CREATE TABLE public.image_send_counts (
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  send_date  date        NOT NULL DEFAULT CURRENT_DATE,
  count      int         NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, send_date)
);

ALTER TABLE public.image_send_counts ENABLE ROW LEVEL SECURITY;

-- Users can read and upsert their own counter row
CREATE POLICY "Users read own image count" ON public.image_send_counts
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "Users upsert own image count" ON public.image_send_counts
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users update own image count" ON public.image_send_counts
  FOR UPDATE TO authenticated USING (user_id = auth.uid());

-- ─── RPC: atomically increment and return today's count ───────────────────────
CREATE OR REPLACE FUNCTION public.increment_image_send_count(p_user_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  INSERT INTO public.image_send_counts (user_id, send_date, count)
    VALUES (p_user_id, CURRENT_DATE, 1)
  ON CONFLICT (user_id, send_date) DO UPDATE
    SET count = image_send_counts.count + 1
  RETURNING count INTO v_count;
  RETURN v_count;
END;
$$;

-- RPC: fetch today's count without incrementing
CREATE OR REPLACE FUNCTION public.get_image_send_count(p_user_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  SELECT count INTO v_count
  FROM public.image_send_counts
  WHERE user_id = p_user_id AND send_date = CURRENT_DATE;
  RETURN COALESCE(v_count, 0);
END;
$$;
