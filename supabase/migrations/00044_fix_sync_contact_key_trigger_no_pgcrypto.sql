-- Replace pgcrypto's digest() with the built-in sha256() function (available
-- since PostgreSQL 11, no extension required).  The previous version called
-- digest(bytea, 'sha256') which requires pgcrypto; if that extension is not
-- installed every PATCH to profiles.public_key fails with:
--   "function digest(bytea, unknown) does not exist"
-- causing the profile sync to never succeed and breaking ratchet key distribution.

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
    -- Uses the built-in sha256(bytea) instead of pgcrypto's digest().
    v_raw_hash := sha256(decode(NEW.public_key, 'base64'));
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