ALTER TABLE public.user_signed_prekeys
  ADD COLUMN IF NOT EXISTS ed25519_pub text;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ed25519_pub text;