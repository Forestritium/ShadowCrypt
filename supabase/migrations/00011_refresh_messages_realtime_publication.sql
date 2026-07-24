-- Refresh the realtime publication for the messages table so all columns
-- (including the newly-added image_url) are included in payload.new for INSERT events.
ALTER PUBLICATION supabase_realtime DROP TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
