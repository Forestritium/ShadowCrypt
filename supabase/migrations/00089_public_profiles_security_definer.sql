-- The public_profiles view exposes only non-sensitive directory columns. The
-- underlying profiles table is locked down so users can only read their own
-- row, but that breaks contact request enrichment because neither party can
-- read the other's username/public_key until after acceptance. Switch the
-- view to security-definer (owner = postgres) so the view bypasses the
-- underlying RLS and returns all rows for authenticated users.
ALTER VIEW public.public_profiles SET (security_invoker = false);