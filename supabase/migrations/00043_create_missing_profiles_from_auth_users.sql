-- Backfill any auth.users that have no corresponding profiles row.
-- This covers accounts whose handle_new_user() trigger silently failed
-- at registration time (e.g. duplicate username race, trigger error).
-- Uses ON CONFLICT DO NOTHING so it is safe to re-run at any time.
INSERT INTO public.profiles (id, email, username, role, password_version)
SELECT
  u.id,
  u.email,
  split_part(u.email, '@', 1) AS username,
  'user'::public.user_role,
  1   -- treat backfilled accounts as modern (Argon2id) so they skip the migration prompt
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL
ON CONFLICT (id) DO NOTHING;

-- Also harden the trigger itself so future re-runs (e.g. from a Supabase
-- internal retry) never crash on the duplicate-key constraint.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, username, role, password_version)
  VALUES (
    NEW.id,
    NEW.email,
    split_part(NEW.email, '@', 1),
    'user'::public.user_role,
    1
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;