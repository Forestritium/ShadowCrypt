
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS is_view_once boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS view_once_consumed boolean NOT NULL DEFAULT false;
