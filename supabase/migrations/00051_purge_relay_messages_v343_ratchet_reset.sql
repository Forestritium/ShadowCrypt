-- v343: Purge all relay_messages accumulated before the ratchet-session reset.
-- After the v343 client-side clearAllRatchetSessions migration, every sender
-- starts a brand-new X3DH session. Any relay rows written by pre-v343 sessions
-- carry header/chain keys that no longer match the receiver's freshly-reset
-- ratchet state, making them permanently undeliverable.  Clearing them here
-- ensures the drain queue starts empty and only processes correctly-keyed rows.
DELETE FROM relay_messages;