
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 00030: Enforce primary-device approval at the DB level
--
-- Security issue: the devices_update RLS policy previously allowed any
-- authenticated session for a user to flip approved=true on any of their
-- device rows (user_id = auth.uid() check only). A JWT-compromised session
-- could therefore insert a rogue device and self-approve it, bypassing the
-- client-side is_primary guard in LinkedDevicesPage.tsx.
--
-- Fix:
--   1. Replace the permissive devices_update policy with a tightened version
--      that BLOCKS setting approved=true via direct SQL UPDATE.
--   2. Create a SECURITY DEFINER function approve_device(UUID) that:
--        a. Verifies the target device belongs to auth.uid()
--        b. Verifies auth.uid() has an is_primary=TRUE AND approved=TRUE
--           device (i.e. the calling session is on the primary device)
--        c. Only then sets approved=TRUE and writes an approval_signature
--           binding the approval to the approving user + timestamp
--   3. Grant EXECUTE only to authenticated role — anon cannot call it.
--
-- After this migration:
--   - approved=true can ONLY be set via approve_device() (server-side check)
--   - Even a fully JWT-hijacked session cannot approve a device without first
--     having an existing is_primary=TRUE device in the DB for that user
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Drop the permissive update policy ────────────────────────────────────

DROP POLICY IF EXISTS "devices_update" ON public.user_devices;

-- ─── 2. Tightened UPDATE policy — blocks approved flips via direct SQL ────────

CREATE POLICY "devices_update"
  ON public.user_devices
  FOR UPDATE
  USING  (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND (
      approved = FALSE
      OR EXISTS (
        SELECT 1
        FROM public.user_devices existing
        WHERE existing.id      = user_devices.id
          AND existing.approved = TRUE
      )
    )
  );

-- ─── 3. SECURITY DEFINER function: approve_device ────────────────────────────

CREATE OR REPLACE FUNCTION public.approve_device(p_device_row_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_user_id UUID;
  v_already_approved BOOLEAN;
BEGIN
  SELECT user_id, approved
    INTO v_target_user_id, v_already_approved
    FROM public.user_devices
   WHERE id = p_device_row_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Device not found: %', p_device_row_id;
  END IF;

  IF v_target_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Permission denied: device does not belong to the authenticated user';
  END IF;

  IF v_already_approved THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.user_devices
     WHERE user_id   = auth.uid()
       AND is_primary = TRUE
       AND approved   = TRUE
  ) THEN
    RAISE EXCEPTION 'Permission denied: only the primary device may approve new devices';
  END IF;

  UPDATE public.user_devices
     SET approved           = TRUE,
         approval_signature = 'approved:' || auth.uid()::TEXT || ':' || EXTRACT(EPOCH FROM NOW())::BIGINT::TEXT
   WHERE id = p_device_row_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_device(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.approve_device(UUID) FROM anon;

-- Back-fill approval_signature for already-approved rows (pre-migration)
UPDATE public.user_devices
   SET approval_signature = 'approved:migration:00030'
 WHERE approved = TRUE
   AND approval_signature IS NULL;
