-- Update delete_conversation_messages_for_both to also delete pins
CREATE OR REPLACE FUNCTION public.delete_conversation_messages_for_both(
  p_user_a uuid,
  p_user_b uuid,
  p_conversation_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete all messages for both users in this conversation
  DELETE FROM messages
    WHERE conversation_id = p_conversation_id
      AND owner_id IN (p_user_a, p_user_b);

  -- Delete all shared conversation pins
  DELETE FROM conversation_pins
    WHERE conversation_id = p_conversation_id;

  -- Delete all personal pins for both users in this conversation
  DELETE FROM personal_pins
    WHERE conversation_id = p_conversation_id
      AND owner_id IN (p_user_a, p_user_b);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_conversation_messages_for_both(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_conversation_messages_for_both(uuid, uuid, text) TO authenticated;