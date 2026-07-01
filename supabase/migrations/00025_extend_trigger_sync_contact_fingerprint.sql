
-- Extend the key-sync trigger to also recompute contacts.fingerprint when
-- contacts.public_key is updated (belt-and-suspenders alongside the JS layer).
-- Fingerprint = first 8 bytes of SHA-256(decoded raw key bytes), formatted as
-- uppercase colon-separated hex pairs — identical to computeFingerprint() in crypto.ts.
-- Requires pgcrypto (pre-installed on every Supabase project).

CREATE OR REPLACE FUNCTION public.sync_contact_public_key()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw_hash  bytea;
  v_fp        text;
  v_byte_val  int;
  v_i         int;
  v_parts     text[] := ARRAY[]::text[];
BEGIN
  -- Only act when the public_key column actually changed
  IF NEW.public_key IS DISTINCT FROM OLD.public_key AND NEW.public_key IS NOT NULL THEN

    -- Compute fingerprint: SHA-256 of the raw (base64-decoded) key bytes,
    -- first 8 bytes formatted as uppercase hex pairs joined with ':'
    v_raw_hash := digest(decode(NEW.public_key, 'base64'), 'sha256');
    FOR v_i IN 0..7 LOOP
      v_byte_val := get_byte(v_raw_hash, v_i);
      v_parts := array_append(v_parts, lpad(upper(to_hex(v_byte_val)), 2, '0'));
    END LOOP;
    v_fp := array_to_string(v_parts, ':');

    UPDATE public.contacts
    SET
      public_key  = NEW.public_key,
      fingerprint = v_fp
    WHERE contact_id = NEW.id
      AND public_key IS DISTINCT FROM NEW.public_key;

  END IF;
  RETURN NEW;
END;
$$;

-- Trigger already exists; DROP + recreate ensures the new function body is used.
DROP TRIGGER IF EXISTS trg_sync_contact_public_key ON public.profiles;
CREATE TRIGGER trg_sync_contact_public_key
  AFTER UPDATE OF public_key ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_contact_public_key();
