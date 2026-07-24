
-- Fix ghost contact-removal bug:
--   A contact_removals row that survived a Realtime cleanup failure (fire-and-forget
--   delete, transient network error) would be picked up by fetchPendingRemovals on
--   the next login and silently re-remove a contact that had already been re-added.
--
-- Three-pronged fix:
--   1. UNIQUE(remover_id, removed_id) — at most one pending notification per pair
--   2. clearContactRemovalsBetween RPC — purges all rows in both directions so that
--      re-adding a contact always starts with a clean slate
--   3. Keep existing rows from breaking the new constraint (delete dupes first)

-- 1. Remove any duplicate rows (keep the most recent per pair before adding the constraint)
DELETE FROM contact_removals a
  USING contact_removals b
 WHERE a.remover_id = b.remover_id
   AND a.removed_id = b.removed_id
   AND a.created_at < b.created_at;

-- 2. Add the UNIQUE constraint (now safe — duplicates are gone)
ALTER TABLE contact_removals
  ADD CONSTRAINT uq_contact_removals_pair UNIQUE (remover_id, removed_id);

-- 3. SECURITY DEFINER RPC that can delete rows in BOTH directions regardless of
--    which party calls it.  The standard DELETE RLS policy only allows the remover
--    OR removed party to delete their own rows, so clearing both directions from a
--    single client would require two round-trips and two separate auth contexts.
--    This function runs with the permissions of its owner (postgres) and is
--    therefore safe to call from either party to clean up stale notifications.
CREATE OR REPLACE FUNCTION public.clear_contact_removals_between(
  p_user_id_a uuid,
  p_user_id_b uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Guard: caller must be one of the two parties
  IF auth.uid() IS DISTINCT FROM p_user_id_a AND auth.uid() IS DISTINCT FROM p_user_id_b THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  DELETE FROM contact_removals
   WHERE (remover_id = p_user_id_a AND removed_id = p_user_id_b)
      OR (remover_id = p_user_id_b AND removed_id = p_user_id_a);
END;
$$;

REVOKE ALL ON FUNCTION public.clear_contact_removals_between(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_contact_removals_between(uuid, uuid) TO authenticated;
