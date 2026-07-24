CREATE OR REPLACE FUNCTION public.is_conversation_participant(
  p_conversation_id text,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
AS $$
DECLARE
  decoded_str text;
  parts text[];
BEGIN
  decoded_str := encode(decode(p_conversation_id, 'base64'), 'escape');
  parts := string_to_array(decoded_str, ':');
  IF array_length(parts, 1) = 3 AND parts[1] = 'dm' THEN
    RETURN parts[2] = p_user_id::text OR parts[3] = p_user_id::text;
  END IF;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;
