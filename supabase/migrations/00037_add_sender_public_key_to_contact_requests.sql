-- Store the sender's public key directly on the contact request row.
-- This eliminates the race-condition dependency on profiles.public_key being
-- written before the receiver accepts — the key travels with the request.
ALTER TABLE contact_requests
  ADD COLUMN IF NOT EXISTS sender_public_key text;

-- Update the QR-path RPC to accept and persist the sender's public key.
CREATE OR REPLACE FUNCTION send_contact_request_via_qr(
  p_receiver_id      uuid,
  p_qr_token         text,
  p_sender_public_key text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender_id        uuid := auth.uid();
  v_profile_token    text;
  v_generated_at     timestamptz;
  v_rotation_days    smallint;
BEGIN
  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'P0001';
  END IF;

  IF v_sender_id = p_receiver_id THEN
    RAISE EXCEPTION 'cannot_add_self' USING ERRCODE = 'P0001';
  END IF;

  SELECT qr_token, qr_generated_at, qr_rotation_days
    INTO v_profile_token, v_generated_at, v_rotation_days
    FROM profiles
   WHERE id = p_receiver_id;

  IF NOT FOUND OR v_profile_token IS NULL THEN
    RAISE EXCEPTION 'invalid_qr_token'
      USING HINT = 'The QR code is invalid or has never been generated.',
            ERRCODE = 'P0001';
  END IF;

  IF v_profile_token <> p_qr_token THEN
    RAISE EXCEPTION 'invalid_qr_token'
      USING HINT = 'The QR code token does not match. Ask the contact to show their current QR code.',
            ERRCODE = 'P0001';
  END IF;

  v_rotation_days := COALESCE(v_rotation_days, 3);
  IF v_generated_at IS NULL
     OR NOW() > v_generated_at + (v_rotation_days || ' days')::interval
  THEN
    RAISE EXCEPTION 'qr_token_expired'
      USING HINT = 'This QR code has expired. Ask your contact to regenerate it.',
            ERRCODE = 'P0001';
  END IF;

  -- Insert with sender's public key embedded in the request row
  INSERT INTO contact_requests (sender_id, receiver_id, sender_public_key)
  VALUES (v_sender_id, p_receiver_id, p_sender_public_key);

  RETURN 'ok';

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'already_requested'
      USING HINT = 'You have already sent a contact request to this user.',
            ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION send_contact_request_via_qr(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION send_contact_request_via_qr(uuid, text, text) TO authenticated;