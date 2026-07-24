
-- SECURITY DEFINER function that runs as superuser, bypassing RLS,
-- to update all contacts rows whose contact_id matches the updated profile.
-- This keeps every stored contact public_key in sync whenever a user's
-- identity key is regenerated (e.g. new device, cleared storage).
CREATE OR REPLACE FUNCTION public.sync_contact_public_key()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act when the public_key column actually changed
  IF NEW.public_key IS DISTINCT FROM OLD.public_key AND NEW.public_key IS NOT NULL THEN
    UPDATE public.contacts
    SET public_key = NEW.public_key
    WHERE contact_id = NEW.id
      AND public_key IS DISTINCT FROM NEW.public_key;
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger fires AFTER every UPDATE on profiles
DROP TRIGGER IF EXISTS trg_sync_contact_public_key ON public.profiles;
CREATE TRIGGER trg_sync_contact_public_key
  AFTER UPDATE OF public_key ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_contact_public_key();
