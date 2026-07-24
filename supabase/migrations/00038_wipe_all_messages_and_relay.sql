-- Wipe every relay message (in-flight or pending) for all users.
-- These were encrypted with corrupted ratchet sessions and are unrecoverable.
DELETE FROM public.relay_messages;

-- Wipe every stored local-message copy for all users.
-- The local vault (IndexedDB/ratchet sessions) are client-side and wiped
-- automatically on next login via the session-reset flow; this clears the
-- server-side DB copy so the chat UI starts completely fresh.
DELETE FROM public.messages;

-- Reset sequences / confirm tables are empty (informational).
SELECT
  (SELECT count(*) FROM public.relay_messages) AS relay_remaining,
  (SELECT count(*) FROM public.messages)        AS messages_remaining;