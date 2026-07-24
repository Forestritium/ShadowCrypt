
-- Pin search_path on the three SECURITY DEFINER helper functions that were
-- missing SET search_path = public.  Without this, a search_path injection
-- attack (schema squatting) could redirect unqualified table lookups inside
-- these functions to attacker-controlled schemas.

ALTER FUNCTION public.can_view_contact_request(uuid, uuid)
  SET search_path = public;

ALTER FUNCTION public.can_manage_block(uuid)
  SET search_path = public;

ALTER FUNCTION public.is_blocked_by_me(uuid)
  SET search_path = public;
