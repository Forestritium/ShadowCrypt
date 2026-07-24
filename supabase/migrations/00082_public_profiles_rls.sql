-- Fix S-M1: Restrict public profiles to authenticated users
DROP VIEW IF EXISTS public.public_profiles;

CREATE OR REPLACE VIEW public.public_profiles AS
SELECT id, username, public_key, bio, created_at, avatar_url, discoverable
FROM public.profiles
WHERE discoverable = true;

-- The view inherits the RLS of the underlying table.
-- We must make sure the `profiles` table does not allow `anon` reads.
-- Or just create a policy specifically for it:
DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON profiles;
CREATE POLICY "Profiles are viewable by authenticated users"
  ON profiles FOR SELECT
  USING (auth.role() = 'authenticated');
