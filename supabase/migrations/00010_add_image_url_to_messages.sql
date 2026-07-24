
-- Add image_url column to messages for image messages
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS image_url text DEFAULT NULL;
