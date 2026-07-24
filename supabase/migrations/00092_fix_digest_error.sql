CREATE OR REPLACE FUNCTION sync_contact_key_on_profile_update()
RETURNS trigger AS $$
DECLARE
  v_raw_hash bytea;
  v_fingerprint text;
BEGIN
  IF NEW.public_key IS DISTINCT FROM OLD.public_key AND NEW.public_key IS NOT NULL THEN
    
    -- When the profile's public key changes, any previous safety number verification is invalidated
    UPDATE contacts 
    SET is_verified = false
    WHERE user_id = NEW.id;

    -- Also compute and broadcast the new fingerprint
    v_raw_hash := sha256(decode(NEW.public_key, 'base64'));
    v_fingerprint := encode(v_raw_hash, 'hex');

    PERFORM pg_notify(
      'contact_key_sync',
      json_build_object(
        'user_id', NEW.id,
        'public_key', NEW.public_key,
        'fingerprint', v_fingerprint
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;