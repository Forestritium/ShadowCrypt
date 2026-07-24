-- Drop the typing_indicators table — feature uses Realtime broadcast channels,
-- this table was never written to or read from in any code path.
DROP TABLE IF EXISTS public.typing_indicators;

-- Drop the public_profiles view — not referenced anywhere in application code.
DROP VIEW IF EXISTS public.public_profiles;