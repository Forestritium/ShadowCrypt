-- Clear all relay_messages that were encrypted with pre-v312 ratchet sessions
-- (old ratchet: prefix).  Receivers running v312+ use ratchet_v2: sessions
-- whose header keys never match the old HK values, so these rows will never
-- decrypt successfully.  Deleting them ends the repeated
-- "All decryption attempts exhausted" error loop.
DELETE FROM public.relay_messages;