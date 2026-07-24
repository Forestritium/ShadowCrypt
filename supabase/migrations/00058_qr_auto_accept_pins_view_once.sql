
-- ─────────────────────────────────────────────────────────────────────────────
-- v5.1.58: QR auto-accept contacts, shared conversation pins, and view-once
-- messages.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. QR AUTO-ACCEPT: add a contact in both directions without approval ────

CREATE OR REPLACE FUNCTION add_contact_via_qr(
  p_receiver_id uuid,
  p_qr_token    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender_id        uuid := auth.uid();
  v_profile_token    text;
  v_generated_at     timestamptz;
  v_rotation_days    smallint;
  v_sender_username  text;
  v_sender_key       text;
  v_receiver_username text;
  v_receiver_key     text;
  v_conversation_id  text;
  v_sender_fp        text;
  v_receiver_fp      text;
  v_raw_hash         bytea;
  v_byte_val         int;
  v_i                int;
  v_parts            text[] := ARRAY[]::text[];
BEGIN
  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'P0001';
  END IF;

  IF v_sender_id = p_receiver_id THEN
    RAISE EXCEPTION 'cannot_add_self' USING ERRCODE = 'P0001';
  END IF;

  -- Validate receiver's QR token
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

  -- Load sender and receiver profiles + keys
  SELECT username, public_key INTO v_sender_username, v_sender_key
    FROM profiles WHERE id = v_sender_id;

  SELECT username, public_key INTO v_receiver_username, v_receiver_key
    FROM profiles WHERE id = p_receiver_id;

  IF v_sender_key IS NULL THEN
    RAISE EXCEPTION 'sender_key_missing'
      USING HINT = 'Your encryption keys are not set up. Please log in again.',
            ERRCODE = 'P0001';
  END IF;

  IF v_receiver_key IS NULL THEN
    RAISE EXCEPTION 'receiver_key_missing'
      USING HINT = 'The scanned user has not finished setting up their vault. Ask them to log in first.',
            ERRCODE = 'P0001';
  END IF;

  -- Deterministic conversation id: sorted UUIDs joined by a colon
  v_conversation_id := concat(
    LEAST(v_sender_id::text, p_receiver_id::text),
    ':',
    GREATEST(v_sender_id::text, p_receiver_id::text)
  );

  -- Compute fingerprint from base64 public key (first 8 bytes as hex pairs)
  v_raw_hash := sha256(decode(v_sender_key, 'base64'));
  v_parts := ARRAY[]::text[];
  FOR v_i IN 0..7 LOOP
    v_byte_val := get_byte(v_raw_hash, v_i);
    v_parts := array_append(v_parts, lpad(upper(to_hex(v_byte_val)), 2, '0'));
  END LOOP;
  v_sender_fp := array_to_string(v_parts, ':');

  v_raw_hash := sha256(decode(v_receiver_key, 'base64'));
  v_parts := ARRAY[]::text[];
  FOR v_i IN 0..7 LOOP
    v_byte_val := get_byte(v_raw_hash, v_i);
    v_parts := array_append(v_parts, lpad(upper(to_hex(v_byte_val)), 2, '0'));
  END LOOP;
  v_receiver_fp := array_to_string(v_parts, ':');

  -- Insert contact relationship from sender -> receiver
  INSERT INTO contacts (
    owner_id, contact_id, username, public_key, fingerprint,
    conversation_id, verified_via_qr, original_fingerprint
  ) VALUES (
    v_sender_id, p_receiver_id, v_receiver_username, v_receiver_key, v_receiver_fp,
    v_conversation_id, true, v_receiver_fp
  )
  ON CONFLICT (owner_id, contact_id) DO UPDATE SET
    public_key          = EXCLUDED.public_key,
    fingerprint         = EXCLUDED.fingerprint,
    verified_via_qr     = true,
    original_fingerprint = EXCLUDED.original_fingerprint;

  -- Insert mirrored relationship from receiver -> sender (SECURITY DEFINER)
  INSERT INTO contacts (
    owner_id, contact_id, username, public_key, fingerprint,
    conversation_id, verified_via_qr, original_fingerprint
  ) VALUES (
    p_receiver_id, v_sender_id, v_sender_username, v_sender_key, v_sender_fp,
    v_conversation_id, true, v_sender_fp
  )
  ON CONFLICT (owner_id, contact_id) DO UPDATE SET
    public_key          = EXCLUDED.public_key,
    fingerprint         = EXCLUDED.fingerprint,
    verified_via_qr     = true,
    original_fingerprint = EXCLUDED.original_fingerprint;

  -- Clear any lingering pending requests in either direction
  DELETE FROM contact_requests
   WHERE (sender_id = v_sender_id AND receiver_id = p_receiver_id)
      OR (sender_id = p_receiver_id AND receiver_id = v_sender_id);

  RETURN jsonb_build_object(
    'ok', true,
    'conversation_id', v_conversation_id,
    'receiver', jsonb_build_object(
      'id', p_receiver_id,
      'username', v_receiver_username,
      'public_key', v_receiver_key,
      'fingerprint', v_receiver_fp
    )
  );

EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION add_contact_via_qr(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION add_contact_via_qr(uuid, text) TO authenticated;


-- ── 2. SHARED CONVERSATION PINS ("pin for everyone") ──────────────────────────

CREATE TABLE IF NOT EXISTS public.conversation_pins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text  NOT NULL,
  message_id      text  NOT NULL,
  pinned_by       uuid  NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, message_id)
);

ALTER TABLE public.conversation_pins ENABLE ROW LEVEL SECURITY;

-- Helper: is a given user a participant of the conversation?
CREATE OR REPLACE FUNCTION is_conversation_participant(
  p_conversation_id text,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.contacts
     WHERE conversation_id = p_conversation_id
       AND (owner_id = p_user_id OR contact_id = p_user_id)
  );
$$;

DROP POLICY IF EXISTS "participants_can_view_pins" ON public.conversation_pins;
CREATE POLICY "participants_can_view_pins" ON public.conversation_pins
  FOR SELECT TO authenticated
  USING (is_conversation_participant(conversation_id, auth.uid()));

DROP POLICY IF EXISTS "participants_can_add_pins" ON public.conversation_pins;
CREATE POLICY "participants_can_add_pins" ON public.conversation_pins
  FOR INSERT TO authenticated
  WITH CHECK (is_conversation_participant(conversation_id, auth.uid()));

DROP POLICY IF EXISTS "pinner_or_participant_can_unpin" ON public.conversation_pins;
CREATE POLICY "pinner_or_participant_can_unpin" ON public.conversation_pins
  FOR DELETE TO authenticated
  USING (pinned_by = auth.uid() OR is_conversation_participant(conversation_id, auth.uid()));

ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_pins;


-- ── 3. VIEW-ONCE MESSAGES ───────────────────────────────────────────────────

ALTER TABLE public.relay_messages
  ADD COLUMN IF NOT EXISTS is_view_once boolean NOT NULL DEFAULT false;

ALTER TABLE public.relay_messages
  ADD COLUMN IF NOT EXISTS view_once_consumed_by uuid[] DEFAULT ARRAY[]::uuid[];
