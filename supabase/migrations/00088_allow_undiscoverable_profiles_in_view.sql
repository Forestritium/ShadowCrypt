-- In 00081 we restricted the public_profiles view using `WHERE discoverable = true`.
-- However, when accepting a contact request, we need to retrieve the sender's public_key
-- even if they are not discoverable.
-- We still want the global directory to hide undiscoverable users, but direct profile
-- lookups by ID (which is what contact requests do) should succeed.

DROP VIEW IF EXISTS public.public_profiles;

-- Instead of filtering out non-discoverable users at the view level, we return all profiles.
-- The application's search functionality should explicitly append `.eq('discoverable', true)`
-- when querying the directory.
CREATE OR REPLACE VIEW public.public_profiles AS
SELECT id, username, public_key, bio, created_at, avatar_url, discoverable
FROM public.profiles;