-- Fix try_increment_image_send_count: tables use send_date/count not day/send_count/id
CREATE OR REPLACE FUNCTION public.try_increment_image_send_count(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today    DATE := CURRENT_DATE;
  v_count    INT;
  v_limit    CONSTANT INT := 10;
BEGIN
  SELECT count INTO v_count
    FROM public.image_send_counts
   WHERE user_id = p_user_id AND send_date = v_today
   FOR UPDATE;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.image_send_counts (user_id, send_date, count)
      VALUES (p_user_id, v_today, 1);
      RETURN TRUE;
    EXCEPTION WHEN unique_violation THEN
      SELECT count INTO v_count
        FROM public.image_send_counts
       WHERE user_id = p_user_id AND send_date = v_today
       FOR UPDATE;
    END;
  END IF;

  IF v_count >= v_limit THEN RETURN FALSE; END IF;
  UPDATE public.image_send_counts
     SET count = count + 1
   WHERE user_id = p_user_id AND send_date = v_today;
  RETURN TRUE;
END;
$$;

-- Fix try_increment_voice_send_duration: tables use send_date/seconds not day/total_seconds/id
CREATE OR REPLACE FUNCTION public.try_increment_voice_send_duration(p_user_id uuid, p_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today    DATE    := CURRENT_DATE;
  v_used     INT;
  v_limit    CONSTANT INT := 600;
BEGIN
  SELECT seconds INTO v_used
    FROM public.voice_send_durations
   WHERE user_id = p_user_id AND send_date = v_today
   FOR UPDATE;

  IF NOT FOUND THEN
    IF p_seconds > v_limit THEN RETURN FALSE; END IF;
    BEGIN
      INSERT INTO public.voice_send_durations (user_id, send_date, seconds)
      VALUES (p_user_id, v_today, p_seconds);
      RETURN TRUE;
    EXCEPTION WHEN unique_violation THEN
      SELECT seconds INTO v_used
        FROM public.voice_send_durations
       WHERE user_id = p_user_id AND send_date = v_today
       FOR UPDATE;
    END;
  END IF;

  IF v_used + p_seconds > v_limit THEN RETURN FALSE; END IF;
  UPDATE public.voice_send_durations
     SET seconds = seconds + p_seconds
   WHERE user_id = p_user_id AND send_date = v_today;
  RETURN TRUE;
END;
$$;

-- Fix try_increment_file_send_bytes: tables use send_date/bytes_sent not day/total_bytes
CREATE OR REPLACE FUNCTION public.try_increment_file_send_bytes(p_user_id uuid, p_bytes bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today    DATE   := CURRENT_DATE;
  v_used     BIGINT;
  v_limit    CONSTANT BIGINT := 62914560; -- 60 MB
BEGIN
  SELECT bytes_sent INTO v_used
    FROM public.file_send_bytes
   WHERE user_id = p_user_id AND send_date = v_today
   FOR UPDATE;

  IF NOT FOUND THEN
    IF p_bytes > v_limit THEN RETURN FALSE; END IF;
    BEGIN
      INSERT INTO public.file_send_bytes (user_id, send_date, bytes_sent)
      VALUES (p_user_id, v_today, p_bytes);
      RETURN TRUE;
    EXCEPTION WHEN unique_violation THEN
      SELECT bytes_sent INTO v_used
        FROM public.file_send_bytes
       WHERE user_id = p_user_id AND send_date = v_today
       FOR UPDATE;
    END;
  END IF;

  IF v_used + p_bytes > v_limit THEN RETURN FALSE; END IF;
  UPDATE public.file_send_bytes
     SET bytes_sent = bytes_sent + p_bytes
   WHERE user_id = p_user_id AND send_date = v_today;
  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.try_increment_image_send_count(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.try_increment_voice_send_duration(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.try_increment_file_send_bytes(uuid, bigint) TO authenticated;