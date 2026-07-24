
-- ── X3DH Prekeys ──────────────────────────────────────────────────────────────
--
-- One row per user: stores the current Signed Prekey (SPK) bundle.
-- On login the client regenerates these and upserts this row.
-- Senders fetch this row before initiating a new Double Ratchet session.
CREATE TABLE IF NOT EXISTS public.user_signed_prekeys (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- The user's X25519 IK public key (mirrors profiles.public_key, kept here for atomic fetch)
  ik_pub        text        NOT NULL,
  -- Signed Prekey: a fresh X25519 key pair generated each login / rotation
  spk_id        text        NOT NULL,
  spk_pub       text        NOT NULL,
  -- Ed25519 signature of the SPK public key (previously HMAC-SHA256).
  -- Verified by the sender before initiating a Double Ratchet session.
  spk_sig       text        NOT NULL,
  -- ML-KEM-768 public key for post-quantum hybrid KEM (optional, null for legacy clients)
  kem_pub       text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_signed_prekeys ENABLE ROW LEVEL SECURITY;

-- Owner can upsert their own row
CREATE POLICY "Owner can upsert signed prekey" ON public.user_signed_prekeys
  FOR ALL TO authenticated
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Any authenticated user can read any signed prekey bundle (needed to send a message)
CREATE POLICY "Authenticated can read signed prekeys" ON public.user_signed_prekeys
  FOR SELECT TO authenticated USING (true);

-- ── One-Time Prekeys (OPK) ────────────────────────────────────────────────────
--
-- Each user uploads a batch of single-use X25519 keys.
-- A sender claims one atomically via the consume_one_time_prekey() RPC.
-- When the pool runs low the client replenishes it.
CREATE TABLE IF NOT EXISTS public.user_one_time_prekeys (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  opk_id     text        NOT NULL,
  opk_pub    text        NOT NULL,
  -- ML-KEM-768 one-time KEM public key (optional, null for legacy)
  kem_opk_pub text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, opk_id)
);

ALTER TABLE public.user_one_time_prekeys ENABLE ROW LEVEL SECURITY;

-- Owner can insert their own OPKs and delete consumed ones
CREATE POLICY "Owner can manage own OPKs" ON public.user_one_time_prekeys
  FOR ALL TO authenticated
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Only the claim RPC (SECURITY DEFINER) reads and deletes OPKs for others
-- Direct SELECT of another user's OPKs is blocked to prevent enumeration
CREATE POLICY "No direct read of others OPKs" ON public.user_one_time_prekeys
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- ── consume_one_time_prekey() ─────────────────────────────────────────────────
--
-- Atomically claims one OPK for a target user and returns it to the caller.
-- Using SECURITY DEFINER so the SELECT + DELETE bypasses the row-level policy
-- that blocks senders from reading a recipient's OPK pool directly.
CREATE OR REPLACE FUNCTION public.consume_one_time_prekey(p_user_id uuid)
RETURNS TABLE(opk_id text, opk_pub text, kem_opk_pub text)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_opk_id     text;
  v_opk_pub    text;
  v_kem_opk_pub text;
  v_row_id     uuid;
BEGIN
  -- Pick the oldest available OPK (FIFO) with a row lock
  SELECT uop.id, uop.opk_id, uop.opk_pub, uop.kem_opk_pub
    INTO v_row_id, v_opk_id, v_opk_pub, v_kem_opk_pub
    FROM user_one_time_prekeys uop
   WHERE uop.user_id = p_user_id
   ORDER BY uop.created_at ASC
   LIMIT 1
     FOR UPDATE SKIP LOCKED;

  IF v_row_id IS NULL THEN
    -- Pool exhausted — return NULL row; sender falls back to SPK-only X3DH
    RETURN;
  END IF;

  DELETE FROM user_one_time_prekeys WHERE id = v_row_id;

  RETURN QUERY SELECT v_opk_id, v_opk_pub, v_kem_opk_pub;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_one_time_prekey(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_one_time_prekey(uuid) TO authenticated;

-- ── Sealed-sender support on relay_messages ───────────────────────────────────
--
-- Add an optional `sender_cert` column that carries the sender's identity
-- certificate encrypted to the recipient's IK.  When present the receiver
-- validates the cert cryptographically rather than trusting the plaintext
-- sender_id field — hiding sender identity from passive DB observers.
ALTER TABLE public.relay_messages
  ADD COLUMN IF NOT EXISTS sender_cert text;

-- Index for fast cert presence queries (used in receive path)
CREATE INDEX IF NOT EXISTS idx_relay_messages_sender_cert
  ON public.relay_messages (id)
  WHERE sender_cert IS NOT NULL;
