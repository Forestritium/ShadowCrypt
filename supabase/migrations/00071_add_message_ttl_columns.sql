ALTER TABLE public.messages
  ADD COLUMN ttl_seconds integer,
  ADD COLUMN expires_at timestamp with time zone;

COMMENT ON COLUMN public.messages.ttl_seconds IS 'Disappearing message TTL in seconds, set by the sender; null means permanent.';
COMMENT ON COLUMN public.messages.expires_at IS 'Server-side deletion deadline computed from created_at + ttl_seconds.';

-- Index to speed up scheduled cleanup of expired messages.
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON public.messages(expires_at);

-- Function to physically delete expired messages (run via scheduled Edge Function/cron).
CREATE OR REPLACE FUNCTION public.delete_expired_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.messages WHERE expires_at IS NOT NULL AND expires_at <= now();
END;
$$;