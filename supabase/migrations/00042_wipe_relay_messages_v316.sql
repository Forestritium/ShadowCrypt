-- Wipe all relay_messages so no messages encrypted under the wrong
-- initSessionReceiver HKr (ratchet_v2 sessions) linger in the queue.
-- New sessions (ratchet_v3) use the corrected byte ranges and will
-- negotiate fresh header keys from scratch.
DELETE FROM relay_messages;