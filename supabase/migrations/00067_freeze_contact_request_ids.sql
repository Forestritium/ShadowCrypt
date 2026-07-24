CREATE OR REPLACE FUNCTION public.freeze_contact_request_ids()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.sender_id IS DISTINCT FROM OLD.sender_id THEN
    RAISE EXCEPTION 'Cannot modify sender_id of a contact request';
  END IF;
  IF NEW.receiver_id IS DISTINCT FROM OLD.receiver_id THEN
    RAISE EXCEPTION 'Cannot modify receiver_id of a contact request';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_freeze_contact_request_ids ON public.contact_requests;
CREATE TRIGGER trigger_freeze_contact_request_ids
  BEFORE UPDATE ON public.contact_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.freeze_contact_request_ids();