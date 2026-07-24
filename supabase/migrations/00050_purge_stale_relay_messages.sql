-- Purge all relay_messages accumulated before the v338-v340 device-ID fixes.
-- These rows have recipient_device_id values that no longer match any active
-- device session (UUIDs were regenerated on cold starts before the localStorage
-- fallback was in place), making them permanently undeliverable.
-- relay_messages is transient by design (30-day auto-delete); clearing it now
-- lets every user start fresh with correctly-addressed messages after re-login.
DELETE FROM relay_messages;