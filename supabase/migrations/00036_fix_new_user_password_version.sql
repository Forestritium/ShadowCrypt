-- Fix: new accounts created via handle_new_user() now get password_version = 1
-- so they never trigger the "Security upgrade required" prompt on second login.
-- Old accounts with version 0 are unaffected and still see the upgrade flow.
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
    1  -- new accounts always use the modern password scheme (Argon2id)
  );
  RETURN NEW;
END;
$$;