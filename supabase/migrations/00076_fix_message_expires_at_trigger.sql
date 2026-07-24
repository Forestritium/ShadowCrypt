-- Fix the trigger so it doesn't overwrite an explicitly provided expires_at
-- This is necessary for receivers who receive a message with an absolute expiresAt
-- computed from the sender's creation time.

CREATE OR REPLACE FUNCTION public.set_message_expires_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.ttl_seconds IS NOT NULL THEN
    IF NEW.expires_at IS NULL THEN
      NEW.expires_at := NEW.created_at + (NEW.ttl_seconds || ' seconds')::interval;
    END IF;
  ELSE
    NEW.expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
