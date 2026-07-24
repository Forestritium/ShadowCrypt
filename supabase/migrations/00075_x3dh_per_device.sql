-- Drop unique constraint on user_signed_prekeys.user_id
ALTER TABLE public.user_signed_prekeys DROP CONSTRAINT IF EXISTS user_signed_prekeys_user_id_key;

-- Add device_id columns
ALTER TABLE public.user_signed_prekeys ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE public.user_one_time_prekeys ADD COLUMN IF NOT EXISTS device_id TEXT;

-- For existing rows, we can just leave device_id as null, or delete them so clients republish
DELETE FROM public.user_signed_prekeys;
DELETE FROM public.user_one_time_prekeys;

ALTER TABLE public.user_signed_prekeys ALTER COLUMN device_id SET NOT NULL;
ALTER TABLE public.user_one_time_prekeys ALTER COLUMN device_id SET NOT NULL;

ALTER TABLE public.user_signed_prekeys ADD CONSTRAINT user_signed_prekeys_user_device_unique UNIQUE (user_id, device_id);
ALTER TABLE public.user_one_time_prekeys DROP CONSTRAINT IF EXISTS user_one_time_prekeys_user_id_opk_id_key;
ALTER TABLE public.user_one_time_prekeys ADD CONSTRAINT user_one_time_prekeys_user_device_opk_unique UNIQUE (user_id, device_id, opk_id);

-- Update consume_one_time_prekey
DROP FUNCTION IF EXISTS public.consume_one_time_prekey(uuid);

CREATE OR REPLACE FUNCTION public.consume_one_time_prekey(p_user_id uuid, p_device_id text)
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
   WHERE uop.user_id = p_user_id AND uop.device_id = p_device_id
   ORDER BY uop.created_at ASC
   LIMIT 1
     FOR UPDATE SKIP LOCKED;

  IF v_row_id IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM user_one_time_prekeys WHERE id = v_row_id;
  RETURN QUERY SELECT v_opk_id, v_opk_pub, v_kem_opk_pub;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_one_time_prekey(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_one_time_prekey(uuid, text) TO authenticated;
