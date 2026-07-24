-- Fix S-L1: Add cron for relay_messages
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION delete_expired_relay_messages() RETURNS void AS $$
BEGIN
  DELETE FROM public.relay_messages WHERE expires_at < now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

SELECT cron.schedule('delete-expired-relay', '0 * * * *', 'SELECT delete_expired_relay_messages()');
