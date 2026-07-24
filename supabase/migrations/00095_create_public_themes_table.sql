CREATE TABLE public.public_themes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  author_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  config jsonb NOT NULL,
  downloads integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.public_themes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public themes are viewable by everyone" 
  ON public.public_themes FOR SELECT 
  USING (true);

CREATE POLICY "Users can insert their own public themes" 
  ON public.public_themes FOR INSERT 
  WITH CHECK (auth.uid() = author_id);

CREATE POLICY "Users can update their own public themes" 
  ON public.public_themes FOR UPDATE 
  USING (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

CREATE POLICY "Users can delete their own public themes" 
  ON public.public_themes FOR DELETE 
  USING (auth.uid() = author_id);

CREATE OR REPLACE FUNCTION public.increment_theme_downloads(theme_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.public_themes
  SET downloads = downloads + 1
  WHERE id = theme_id;
END;
$$;