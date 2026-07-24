REVOKE SELECT ON public.public_profiles FROM anon;
GRANT SELECT ON public.public_profiles TO authenticated;
