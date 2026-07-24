
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 00031: Atomic rate-limit RPCs, device cap, relay cascade,
--                  search_path hardening on legacy SECURITY DEFINER functions
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Fix #3: Atomic try_increment_* RPCs (TOCTOU race prevention) ─────────────

CREATE OR REPLACE FUNCTION public.try_increment_image_send_count(p_user_id UUID)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today  DATE := CURRENT_DATE;
  v_count  INT;
  v_id     UUID;
BEGIN
  SELECT id, send_count INTO v_id, v_count
    FROM public.image_send_counts
   WHERE user_id = p_user_id AND day = v_today
   FOR UPDATE;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.image_send_counts (user_id, day, send_count)
      VALUES (p_user_id, v_today, 1);
      RETURN TRUE;
    EXCEPTION WHEN unique_violation THEN
      -- Lost INSERT race; re-read and fall through to the UPDATE path below
      SELECT id, send_count INTO v_id, v_count
        FROM public.image_send_counts
       WHERE user_id = p_user_id AND day = v_today
       FOR UPDATE;
    END;
  END IF;

  IF v_count >= 10 THEN
    RETURN FALSE;
  END IF;

  UPDATE public.image_send_counts
     SET send_count = send_count + 1
   WHERE id = v_id;
  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.try_increment_image_send_count(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.try_increment_voice_send_duration(p_user_id UUID, p_seconds INT)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today  DATE    := CURRENT_DATE;
  v_used   INT;
  v_id     UUID;
  v_limit  CONSTANT INT := 600;
BEGIN
  SELECT id, total_seconds INTO v_id, v_used
    FROM public.voice_send_durations
   WHERE user_id = p_user_id AND day = v_today
   FOR UPDATE;

  IF NOT FOUND THEN
    IF p_seconds > v_limit THEN RETURN FALSE; END IF;
    BEGIN
      INSERT INTO public.voice_send_durations (user_id, day, total_seconds)
      VALUES (p_user_id, v_today, p_seconds);
      RETURN TRUE;
    EXCEPTION WHEN unique_violation THEN
      SELECT id, total_seconds INTO v_id, v_used
        FROM public.voice_send_durations
       WHERE user_id = p_user_id AND day = v_today
       FOR UPDATE;
    END;
  END IF;

  IF v_used + p_seconds > v_limit THEN RETURN FALSE; END IF;
  UPDATE public.voice_send_durations SET total_seconds = total_seconds + p_seconds WHERE id = v_id;
  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.try_increment_voice_send_duration(UUID, INT) TO authenticated;

CREATE OR REPLACE FUNCTION public.try_increment_file_send_bytes(p_user_id UUID, p_bytes BIGINT)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today  DATE   := CURRENT_DATE;
  v_used   BIGINT;
  v_id     UUID;
  v_limit  CONSTANT BIGINT := 62914560;
BEGIN
  SELECT id, total_bytes INTO v_id, v_used
    FROM public.file_send_bytes
   WHERE user_id = p_user_id AND day = v_today
   FOR UPDATE;

  IF NOT FOUND THEN
    IF p_bytes > v_limit THEN RETURN FALSE; END IF;
    BEGIN
      INSERT INTO public.file_send_bytes (user_id, day, total_bytes)
      VALUES (p_user_id, v_today, p_bytes);
      RETURN TRUE;
    EXCEPTION WHEN unique_violation THEN
      SELECT id, total_bytes INTO v_id, v_used
        FROM public.file_send_bytes
       WHERE user_id = p_user_id AND day = v_today
       FOR UPDATE;
    END;
  END IF;

  IF v_used + p_bytes > v_limit THEN RETURN FALSE; END IF;
  UPDATE public.file_send_bytes SET total_bytes = total_bytes + p_bytes WHERE id = v_id;
  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.try_increment_file_send_bytes(UUID, BIGINT) TO authenticated;

-- ─── Fix #7: Device count cap — max 10 devices per user ───────────────────────
CREATE OR REPLACE FUNCTION public.enforce_device_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (SELECT COUNT(*) FROM public.user_devices WHERE user_id = NEW.user_id) >= 10 THEN
    RAISE EXCEPTION 'device_limit_exceeded: maximum 10 devices per account';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_device_limit ON public.user_devices;
CREATE TRIGGER trg_enforce_device_limit
  BEFORE INSERT ON public.user_devices
  FOR EACH ROW EXECUTE FUNCTION public.enforce_device_limit();

-- ─── Fix #8: Cascade relay_messages cleanup on device removal ─────────────────
CREATE OR REPLACE FUNCTION public.cleanup_device_relay_messages()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.relay_messages
   WHERE recipient_device_id = OLD.device_id
     AND recipient_id = OLD.user_id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_cleanup_device_relay ON public.user_devices;
CREATE TRIGGER trg_cleanup_device_relay
  BEFORE DELETE ON public.user_devices
  FOR EACH ROW EXECUTE FUNCTION public.cleanup_device_relay_messages();

-- ─── Fix #11: Pin search_path on legacy SECURITY DEFINER functions ─────────────
CREATE OR REPLACE FUNCTION public.can_view_contact_request(req_sender_id uuid, req_receiver_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() = req_sender_id OR auth.uid() = req_receiver_id;
$$;

CREATE OR REPLACE FUNCTION public.can_manage_block(row_blocker_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT row_blocker_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_blocked_by_me(row_blocked_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.blocked_users
    WHERE blocker_id = auth.uid() AND blocked_id = row_blocked_id
  );
$$;
