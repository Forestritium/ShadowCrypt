
-- Add username_last_changed to profiles
ALTER TABLE profiles ADD COLUMN username_last_changed timestamptz;

-- Create contact_removals table for mutual removal events
CREATE TABLE contact_removals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  remover_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  removed_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for fast lookup by removed_id (receiver of removal notification)
CREATE INDEX idx_contact_removals_removed_id ON contact_removals(removed_id);

-- Enable RLS
ALTER TABLE contact_removals ENABLE ROW LEVEL SECURITY;

-- Policy: users can insert their own removals
CREATE POLICY "users can insert own removals"
  ON contact_removals FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = remover_id);

-- Policy: users can select removals where they are the removed party
CREATE POLICY "users can see removals targeting them"
  ON contact_removals FOR SELECT
  TO authenticated
  USING (auth.uid() = removed_id);

-- Policy: remover can delete their own removal records (cleanup)
CREATE POLICY "users can delete own removals"
  ON contact_removals FOR DELETE
  TO authenticated
  USING (auth.uid() = remover_id OR auth.uid() = removed_id);

-- Enable realtime for contact_removals
ALTER PUBLICATION supabase_realtime ADD TABLE contact_removals;
