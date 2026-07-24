-- Realtime DELETE payloads on conversation_pins need the conversation_id
-- column in the old tuple for the client-side filter to match. The default
-- REPLICA IDENTITY only includes the primary key, so unpin-for-everyone
-- changes were not being pushed to other participants until they refreshed.
ALTER TABLE IF EXISTS public.conversation_pins REPLICA IDENTITY FULL;
