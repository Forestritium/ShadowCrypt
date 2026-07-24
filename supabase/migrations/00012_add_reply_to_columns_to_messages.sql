ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS reply_to_id       text        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reply_to_sender   text        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reply_to_snippet  text        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reply_to_image_url text       DEFAULT NULL;
