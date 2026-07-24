-- The original WITH CHECK on the profiles UPDATE policy called get_user_role(auth.uid()).
-- When the client JWT is expired, auth.uid() returns NULL inside that function,
-- causing it to return NULL.  The comparison
--   role IS NOT DISTINCT FROM NULL  →  false (role is 'user', not NULL)
-- makes the WITH CHECK fail → PostgREST updates 0 rows → returns 404.
--
-- Fix: replace WITH CHECK with a simple auth.uid() = id guard (same semantics
-- as the USING clause) and protect the role column at the column-privilege level
-- so no client — even with a valid JWT — can change role via a direct UPDATE.

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;

CREATE POLICY "Users can update their own profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING  (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Column-level privilege: revoke UPDATE on role from authenticated users.
-- Admin role changes must go through a SECURITY DEFINER function or be
-- performed by the postgres service role.
REVOKE UPDATE (role) ON public.profiles FROM authenticated;