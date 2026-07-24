CREATE OR REPLACE FUNCTION public.cleanup_device_related_data()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Cleanup relay messages
  DELETE FROM public.relay_messages
   WHERE recipient_device_id = OLD.device_id
     AND recipient_id = OLD.user_id;
     
  -- Cleanup prekeys
  DELETE FROM public.user_signed_prekeys
   WHERE device_id = OLD.device_id
     AND user_id = OLD.user_id;
     
  DELETE FROM public.user_one_time_prekeys
   WHERE device_id = OLD.device_id
     AND user_id = OLD.user_id;
     
  -- Cleanup push subscriptions
  DELETE FROM public.push_subscriptions
   WHERE device_id = OLD.device_id
     AND user_id = OLD.user_id;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_cleanup_device_related_data ON public.user_devices;
CREATE TRIGGER trg_cleanup_device_related_data
  BEFORE DELETE ON public.user_devices
  FOR EACH ROW EXECUTE FUNCTION public.cleanup_device_related_data();

-- Drop the old trigger and function
DROP TRIGGER IF EXISTS trg_cleanup_device_relay ON public.user_devices;
DROP FUNCTION IF EXISTS public.cleanup_device_relay_messages();
