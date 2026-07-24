-- Set REPLICA IDENTITY FULL on message_reactions so that DELETE events
-- include all columns (especially message_id) in payload.old.
-- Without this, only the PK (id) is present in the WAL old-row record,
-- which means the Realtime DELETE handler cannot determine which message's
-- reaction was removed, breaking un-react sync for the recipient.
ALTER TABLE message_reactions REPLICA IDENTITY FULL;