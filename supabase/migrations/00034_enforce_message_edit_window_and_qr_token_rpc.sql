
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. SERVER-SIDE 5-MINUTE EDIT / DELETE WINDOW ON messages
-- ─────────────────────────────────────────────────────────────────────────────

-- Trigger function: fires BEFORE UPDATE or DELETE on messages.
-- For edits  (UPDATE): only block when the edit flag is being set (is_edited → true).
--   Owner updating their own copy to mark it as deleted-for-everyone is also
--   subject to the window — both mutation types must complete within 5 minutes
--   of the original created_at.
-- Exception code 'P0001' + SQLSTATE recognised by the PostgREST client as a
-- 422 error, so the client can surface a friendly message.
CREATE OR REPLACE FUNCTION enforce_message_edit_window()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only enforce when an edit or delete-for-everyone mutation is being applied.
  -- Plain content re-encryption (vault key change) or read-receipt updates are
  -- not gated, so we scope the check to the two mutation columns.
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.is_edited = TRUE AND OLD.is_edited = FALSE)
       OR (NEW.is_deleted_for_everyone = TRUE AND OLD.is_deleted_for_everyone = FALSE)
    THEN
      IF NOW() > OLD.created_at + INTERVAL '5 minutes' THEN
        RAISE EXCEPTION 'edit_window_expired'
          USING HINT = 'Messages cannot be edited or deleted after 5 minutes.',
                ERRCODE = 'P0001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Permanent deletion of own copy is always allowed (privacy right).
    -- Only block if this looks like a "delete for everyone" attempt after the
    -- window, which in practice is handled via UPDATE above. We allow DELETE
    -- unrestricted so users can always purge their local copy.
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

-- Attach the trigger to messages (BEFORE so it can abort the operation cleanly)
DROP TRIGGER IF EXISTS messages_enforce_edit_window ON messages;
CREATE TRIGGER messages_enforce_edit_window
  BEFORE UPDATE OR DELETE ON messages
  FOR EACH ROW
  EXECUTE FUNCTION enforce_message_edit_window();

-- UPDATE RLS policy: owner may update their own message copy, but only within
-- the 5-minute window (USING clause checked before the row is touched).
-- Belt-and-suspenders with the trigger above — the trigger fires even when
-- RLS is bypassed by a service-role call.
DROP POLICY IF EXISTS "owner_can_update_within_window" ON messages;
CREATE POLICY "owner_can_update_within_window" ON messages
  FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = owner_id
    AND NOW() <= created_at + INTERVAL '5 minutes'
  )
  WITH CHECK (auth.uid() = owner_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. SERVER-SIDE QR TOKEN VALIDATION FOR CONTACT REQUESTS
-- ─────────────────────────────────────────────────────────────────────────────

-- SECURITY DEFINER RPC: validates the scanned qr_token against profiles before
-- inserting the contact request.  Using SECURITY DEFINER lets us read
-- profiles.qr_token (which has RLS) without exposing the token via a SELECT
-- the client could forge.
--
-- Returns: 'ok' on success.
-- Raises P0001 'invalid_qr_token'   when token does not match.
-- Raises P0001 'qr_token_expired'   when token was rotated (qr_generated_at
--                                    is NULL or older than qr_rotation_days).
-- Raises P0001 'already_requested'  when a pending request already exists.
CREATE OR REPLACE FUNCTION send_contact_request_via_qr(
  p_receiver_id  uuid,
  p_qr_token     text
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
  v_token_age_days   numeric;
BEGIN
  -- Must be authenticated
  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'P0001';
  END IF;

  -- Cannot add yourself
  IF v_sender_id = p_receiver_id THEN
    RAISE EXCEPTION 'cannot_add_self' USING ERRCODE = 'P0001';
  END IF;

  -- Read the receiver's current QR state (bypasses RLS via SECURITY DEFINER)
  SELECT qr_token, qr_generated_at, qr_rotation_days
    INTO v_profile_token, v_generated_at, v_rotation_days
    FROM profiles
   WHERE id = p_receiver_id;

  IF NOT FOUND OR v_profile_token IS NULL THEN
    RAISE EXCEPTION 'invalid_qr_token'
      USING HINT = 'The QR code is invalid or has never been generated.',
            ERRCODE = 'P0001';
  END IF;

  -- Validate token matches
  IF v_profile_token <> p_qr_token THEN
    RAISE EXCEPTION 'invalid_qr_token'
      USING HINT = 'The QR code token does not match. Ask the contact to show their current QR code.',
            ERRCODE = 'P0001';
  END IF;

  -- Validate token is not past its rotation window
  v_rotation_days := COALESCE(v_rotation_days, 3);
  IF v_generated_at IS NULL
     OR NOW() > v_generated_at + (v_rotation_days || ' days')::interval
  THEN
    RAISE EXCEPTION 'qr_token_expired'
      USING HINT = 'This QR code has expired. Ask your contact to regenerate it.',
            ERRCODE = 'P0001';
  END IF;

  -- Insert the contact request (unique constraint handles duplicates)
  INSERT INTO contact_requests (sender_id, receiver_id)
  VALUES (v_sender_id, p_receiver_id);

  RETURN 'ok';

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'already_requested'
      USING HINT = 'You have already sent a contact request to this user.',
            ERRCODE = 'P0001';
END;
$$;

-- Grant execute to authenticated users only
REVOKE ALL ON FUNCTION send_contact_request_via_qr(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION send_contact_request_via_qr(uuid, text) TO authenticated;
