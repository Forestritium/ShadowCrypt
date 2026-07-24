
-- User roles enum
CREATE TYPE public.user_role AS ENUM ('user', 'admin');

-- Profiles table (synced from auth.users)
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text UNIQUE NOT NULL,
  email text,
  role public.user_role NOT NULL DEFAULT 'user',
  public_key text, -- ECDH public key for key exchange
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Helper function to get user role
CREATE OR REPLACE FUNCTION get_user_role(uid uuid)
RETURNS user_role
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM profiles WHERE id = uid;
$$;

-- Profiles policies
CREATE POLICY "Users can view their own profile" ON profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile" ON profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id)
  WITH CHECK (role IS NOT DISTINCT FROM get_user_role(auth.uid()));

CREATE POLICY "Admins have full access to profiles" ON profiles
  FOR ALL TO authenticated USING (get_user_role(auth.uid()) = 'admin'::user_role);

-- Allow any authenticated user to look up a username (for username availability check)
CREATE POLICY "Anyone can check username availability" ON profiles
  FOR SELECT TO anon, authenticated USING (true);

-- Public profiles view
CREATE VIEW public_profiles AS
  SELECT id, username, role, public_key FROM profiles;

-- Trigger: sync new users to profiles
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, username, role)
  VALUES (
    NEW.id,
    NEW.email,
    split_part(NEW.email, '@', 1),
    'user'::public.user_role
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();

-- Relay messages table (ephemeral relay only - messages cleared after delivery)
-- This is NOT for storage — only for in-flight relay to offline users
CREATE TABLE public.relay_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  conversation_id text NOT NULL, -- hash of sorted participant IDs
  encrypted_payload text NOT NULL, -- ciphertext only, never plaintext
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.relay_messages ENABLE ROW LEVEL SECURITY;

-- Relay messages auto-expire after 24 hours (transient relay)
CREATE OR REPLACE FUNCTION delete_expired_relay_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  DELETE FROM relay_messages WHERE created_at < now() - interval '24 hours';
END;
$$;

-- Relay message policies
CREATE POLICY "Users can insert relay messages" ON relay_messages
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = sender_id);

CREATE POLICY "Users can view messages addressed to them" ON relay_messages
  FOR SELECT TO authenticated USING (auth.uid() = recipient_id);

CREATE POLICY "Users can delete messages they received" ON relay_messages
  FOR DELETE TO authenticated USING (auth.uid() = recipient_id);

-- Enable Realtime for relay_messages
ALTER PUBLICATION supabase_realtime ADD TABLE relay_messages;
