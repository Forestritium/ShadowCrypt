-- Ensure disappearing messages are cleaned up from both persistent storage
-- and the transient relay queue.  The server computes expires_at from
-- created_at + ttl_seconds so client clock skew cannot cause a message to
-- disappear too early or live too long.

-- Update the cleanup routine to purge expired rows from both tables.
CREATE OR REPLACE FUNCTION public.delete_expired_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.messages WHERE expires_at IS NOT NULL AND expires_at <= now();
  DELETE FROM public.relay_messages WHERE expires_at IS NOT NULL AND expires_at <= now();
END;
$$;

-- Trigger function: derive messages.expires_at from created_at + ttl_seconds.
CREATE OR REPLACE FUNCTION public.set_message_expires_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.ttl_seconds IS NOT NULL THEN
    NEW.expires_at := NEW.created_at + (NEW.ttl_seconds || ' seconds')::interval;
  ELSE
    NEW.expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger function: derive relay_messages.expires_at from created_at + ttl_seconds.
CREATE OR REPLACE FUNCTION public.set_relay_message_expires_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.ttl_seconds IS NOT NULL THEN
    NEW.expires_at := NEW.created_at + (NEW.ttl_seconds || ' seconds')::interval;
  ELSE
    NEW.expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Attach triggers to keep expires_at in sync with ttl_seconds.
DROP TRIGGER IF EXISTS set_message_expires_at ON public.messages;
CREATE TRIGGER set_message_expires_at
  BEFORE INSERT OR UPDATE OF ttl_seconds, created_at ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.set_message_expires_at();

DROP TRIGGER IF EXISTS set_relay_message_expires_at ON public.relay_messages;
CREATE TRIGGER set_relay_message_expires_at
  BEFORE INSERT OR UPDATE OF ttl_seconds, created_at ON public.relay_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.set_relay_message_expires_at();
