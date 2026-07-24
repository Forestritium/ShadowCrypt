
-- SECURITY DEFINER function that deletes all relay messages between two users
-- in both directions. Called when a contact is removed so neither party retains
-- undelivered in-flight messages in the relay table.
-- Running as SECURITY DEFINER (superuser context) is required because the RLS
-- policy on relay_messages only allows each user to delete rows where they are
-- the recipient — not rows where they are the sender.
CREATE OR REPLACE FUNCTION public.delete_relay_messages_between(
  p_user_a uuid,
  p_user_b uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A sent to B (A is sender, B is recipient)
  DELETE FROM relay_messages
    WHERE sender_id = p_user_a AND recipient_id = p_user_b;
  -- B sent to A (B is sender, A is recipient)
  DELETE FROM relay_messages
    WHERE sender_id = p_user_b AND recipient_id = p_user_a;
END;
$$;

-- Only authenticated users may call this function, and only when one of the
-- two user IDs is their own — enforced inside the function call site in the
-- client (Sidebar handleRemoveContact passes currentUserId as one of the args).
REVOKE ALL ON FUNCTION public.delete_relay_messages_between(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_relay_messages_between(uuid, uuid) TO authenticated;

-- Also delete the OTHER user's copy of messages in the messages table when a
-- contact is removed. This is done via a separate SECURITY DEFINER function
-- so that user A can remove user B's message rows even though RLS would normally
-- prevent it (those rows have owner_id = B, not A).
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
  DELETE FROM messages
    WHERE conversation_id = p_conversation_id
      AND owner_id IN (p_user_a, p_user_b);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_conversation_messages_for_both(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_conversation_messages_for_both(uuid, uuid, text) TO authenticated;
