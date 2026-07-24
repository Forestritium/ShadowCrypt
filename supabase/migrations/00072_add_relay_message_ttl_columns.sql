ALTER TABLE public.relay_messages
  ADD COLUMN ttl_seconds integer,
  ADD COLUMN expires_at timestamp with time zone;

COMMENT ON COLUMN public.relay_messages.ttl_seconds IS 'Disappearing message TTL in seconds, copied from sender; null means permanent.';
COMMENT ON COLUMN public.relay_messages.expires_at IS 'Server-side deletion deadline computed from created_at + ttl_seconds.';

CREATE INDEX IF NOT EXISTS idx_relay_messages_expires_at ON public.relay_messages(expires_at);