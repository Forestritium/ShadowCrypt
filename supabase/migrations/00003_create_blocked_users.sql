
-- Blocked users table: blocker_id blocks blocked_id
CREATE TABLE blocked_users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (blocker_id, blocked_id)
);

-- RLS
ALTER TABLE blocked_users ENABLE ROW LEVEL SECURITY;

-- Helper: can a user manage their own block entries?
CREATE OR REPLACE FUNCTION can_manage_block(row_blocker_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT row_blocker_id = auth.uid();
$$;

-- Helper: is a given user blocked by the current user?
CREATE OR REPLACE FUNCTION is_blocked_by_me(row_blocked_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM blocked_users
    WHERE blocker_id = auth.uid() AND blocked_id = row_blocked_id
  );
$$;

-- Policies
CREATE POLICY "blocker can insert own blocks" ON blocked_users
  FOR INSERT TO authenticated
  WITH CHECK (can_manage_block(blocker_id));

CREATE POLICY "blocker can select own blocks" ON blocked_users
  FOR SELECT TO authenticated
  USING (can_manage_block(blocker_id));

CREATE POLICY "blocker can delete own blocks" ON blocked_users
  FOR DELETE TO authenticated
  USING (can_manage_block(blocker_id));
