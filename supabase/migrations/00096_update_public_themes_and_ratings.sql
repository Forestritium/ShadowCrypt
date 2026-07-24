ALTER TABLE public.public_themes ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE public.public_themes ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'dark';
ALTER TABLE public.public_themes ADD COLUMN IF NOT EXISTS rating_sum integer DEFAULT 0;
ALTER TABLE public.public_themes ADD COLUMN IF NOT EXISTS rating_count integer DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.theme_ratings (
  theme_id uuid REFERENCES public.public_themes(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  rating integer CHECK (rating >= 1 AND rating <= 5),
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (theme_id, user_id)
);

ALTER TABLE public.theme_ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ratings viewable by everyone" ON public.theme_ratings
  FOR SELECT USING (true);

CREATE POLICY "Users can insert their own ratings" ON public.theme_ratings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own ratings" ON public.theme_ratings
  FOR UPDATE USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.rate_theme(p_theme_id uuid, p_rating integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_rating integer;
BEGIN
  SELECT rating INTO v_old_rating FROM public.theme_ratings WHERE theme_id = p_theme_id AND user_id = auth.uid();
  
  IF v_old_rating IS NULL THEN
    INSERT INTO public.theme_ratings (theme_id, user_id, rating) VALUES (p_theme_id, auth.uid(), p_rating);
    UPDATE public.public_themes SET rating_sum = rating_sum + p_rating, rating_count = rating_count + 1 WHERE id = p_theme_id;
  ELSE
    UPDATE public.theme_ratings SET rating = p_rating WHERE theme_id = p_theme_id AND user_id = auth.uid();
    UPDATE public.public_themes SET rating_sum = rating_sum - v_old_rating + p_rating WHERE id = p_theme_id;
  END IF;
END;
$$;