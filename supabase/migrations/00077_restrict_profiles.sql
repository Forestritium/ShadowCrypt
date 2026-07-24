-- Drop the existing view so we can recreate it with more columns
DROP VIEW IF EXISTS public_profiles;

CREATE VIEW public_profiles AS
  SELECT 
    id, 
    username, 
    role, 
    discoverable, 
    public_key, 
    bio, 
    avatar_url, 
    avatar_private, 
    qr_rotation_days
  FROM profiles;

-- Make sure the permissive policy is removed
DROP POLICY IF EXISTS "Anyone can check username availability" ON profiles;

-- Create a restrictive policy for selecting from profiles
CREATE POLICY "Users can read their own profile" ON profiles
  FOR SELECT TO authenticated, anon USING (auth.uid() = id);

-- Grant select on public_profiles
GRANT SELECT ON public_profiles TO authenticated, anon;
