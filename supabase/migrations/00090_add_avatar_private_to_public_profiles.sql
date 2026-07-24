-- The public_profiles view is missing avatar_private, which the UI needs to
-- decide whether to show a contact's avatar. Recreate the view with the
-- additional column while preserving the security-definer setting.
DROP VIEW public.public_profiles;

CREATE VIEW public.public_profiles WITH (security_invoker = false) AS
SELECT id, username, public_key, bio, created_at, avatar_url, avatar_private, discoverable
FROM public.profiles;