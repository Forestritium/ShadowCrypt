-- Schedule automatic cleanup of expired disappearing messages every 5 minutes.
SELECT cron.schedule('delete-expired-messages', '*/5 * * * *', 'SELECT public.delete_expired_messages()');