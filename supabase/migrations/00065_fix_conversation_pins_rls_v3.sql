CREATE OR REPLACE FUNCTION public.is_conversation_participant(
  p_conversation_id text,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
AS $$
BEGIN
  -- Validate that the user is actually part of the base64 conversation string
  -- "dm:uuid1:uuid2"
  RETURN encode(decode(p_conversation_id, 'base64'), 'escape') LIKE 'dm:%' || p_user_id::text || '%';
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;