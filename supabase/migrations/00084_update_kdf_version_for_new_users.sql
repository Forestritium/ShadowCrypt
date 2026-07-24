-- Fix S-H1: Update KDF parameters for new accounts
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, username, role, password_version, kdf_version)
  VALUES (
    NEW.id,
    NEW.email,
    split_part(NEW.email, '@', 1),
    'user'::public.user_role,
    1,
    2  -- new accounts always use the modern password scheme (Argon2id V2)
  );
  RETURN NEW;
END;
$$;
