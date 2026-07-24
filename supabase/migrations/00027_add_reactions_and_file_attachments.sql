
-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 00027: Message reactions + File attachments
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. message_reactions table ───────────────────────────────────────────────
-- Stores emoji reactions. Both participants can see reactions (not encrypted —
-- emoji reactions are low-sensitivity metadata, same as Signal/WhatsApp).
-- Unique per (message_id, user_id, emoji) — one of each emoji per user per msg.
CREATE TABLE message_reactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id       text NOT NULL,        -- local message UUID from messages table
  conversation_id  text NOT NULL,        -- so recipient can subscribe per-conv
  sender_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji            text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, sender_id, emoji)
);

ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;

-- Sender can insert their own reactions
CREATE POLICY "reactions_insert" ON message_reactions
  FOR INSERT TO authenticated
  WITH CHECK (sender_id = auth.uid());

-- Both sender and recipient can read reactions in their conversations
CREATE POLICY "reactions_select" ON message_reactions
  FOR SELECT TO authenticated
  USING (sender_id = auth.uid() OR recipient_id = auth.uid());

-- Sender can delete (un-react) their own reactions
CREATE POLICY "reactions_delete" ON message_reactions
  FOR DELETE TO authenticated
  USING (sender_id = auth.uid());

-- Index for fast lookup by conversation
CREATE INDEX idx_message_reactions_conversation ON message_reactions (conversation_id, message_id);

-- ── 2. file_send_bytes table — daily quota tracking ──────────────────────────
CREATE TABLE file_send_bytes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  send_date date NOT NULL DEFAULT CURRENT_DATE,
  bytes_sent bigint NOT NULL DEFAULT 0,
  UNIQUE (user_id, send_date)
);

ALTER TABLE file_send_bytes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "file_bytes_all" ON file_send_bytes
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── 3. RPC: get_file_send_bytes ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_file_send_bytes(p_user_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bytes bigint;
BEGIN
  SELECT COALESCE(bytes_sent, 0) INTO v_bytes
  FROM file_send_bytes
  WHERE user_id = p_user_id AND send_date = CURRENT_DATE;
  RETURN COALESCE(v_bytes, 0);
END;
$$;

-- ── 4. RPC: increment_file_send_bytes ────────────────────────────────────────
CREATE OR REPLACE FUNCTION increment_file_send_bytes(p_user_id uuid, p_bytes bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new bigint;
BEGIN
  INSERT INTO file_send_bytes (user_id, send_date, bytes_sent)
  VALUES (p_user_id, CURRENT_DATE, p_bytes)
  ON CONFLICT (user_id, send_date)
  DO UPDATE SET bytes_sent = file_send_bytes.bytes_sent + EXCLUDED.bytes_sent
  RETURNING bytes_sent INTO v_new;
  RETURN v_new;
END;
$$;

-- ── 5. Add file attachment columns to messages table ─────────────────────────
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS file_storage_path  text,
  ADD COLUMN IF NOT EXISTS file_key_b64        text,   -- vault-encrypted AES-256-GCM key
  ADD COLUMN IF NOT EXISTS file_name           text,
  ADD COLUMN IF NOT EXISTS file_size           bigint,
  ADD COLUMN IF NOT EXISTS file_mime_type      text;

-- ── 6. chat-files storage bucket ─────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-files',
  'chat-files',
  false,
  104857600,   -- 100 MB max per individual upload (server-side cap)
  ARRAY['application/octet-stream']
)
ON CONFLICT (id) DO NOTHING;

-- Only authenticated users can upload to their own folder
CREATE POLICY "chat_files_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Sender and recipient can read (via signed URL)
CREATE POLICY "chat_files_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'chat-files');

-- Uploader can delete their own files
CREATE POLICY "chat_files_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'chat-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── 7. Enable Realtime on message_reactions ───────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE message_reactions;
