ALTER TABLE profiles ADD COLUMN bio_private BOOLEAN DEFAULT false NOT NULL;

DROP VIEW public.public_profiles;

CREATE VIEW public.public_profiles WITH (security_invoker = false) AS
SELECT id, username, public_key, bio, bio_private, created_at, avatar_url, avatar_private, discoverable
FROM public.profiles;
