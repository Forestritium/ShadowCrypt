
-- 1. Add per-user salt for mnemonic hash (replaces unsalted SHA-256 with PBKDF2-salted hash)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS mnemonic_salt text;

COMMENT ON COLUMN profiles.mnemonic_salt IS
  'Random 16-byte base64 salt used in PBKDF2-SHA256(mnemonic, salt, 100000 iters) stored in mnemonic_hash. '
  'NULL means the hash was stored with the legacy unsalted SHA-256 format and must be regenerated.';

-- Update existing comment to reflect new algorithm
COMMENT ON COLUMN profiles.mnemonic_hash IS
  'PBKDF2-SHA256 (100 000 iterations, 32 bytes) of the BIP-39 recovery phrase using the per-user mnemonic_salt. '
  'NULL salt = legacy unsalted SHA-256 (invalid — user must regenerate recovery phrase).';

-- 2. Rate-limit table for password-reset attempts
--    Keyed by SHA-256(username) to avoid storing plaintext usernames.
CREATE TABLE IF NOT EXISTS password_reset_rate_limit (
  id            bigserial PRIMARY KEY,
  username_hash text        NOT NULL,       -- SHA-256 hex of lowercased username
  attempts      integer     NOT NULL DEFAULT 0,
  window_start  timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_prrl_username_hash ON password_reset_rate_limit (username_hash);

COMMENT ON TABLE password_reset_rate_limit IS
  'Tracks failed password-reset attempts per username to prevent brute-force and enumeration attacks. '
  'Policy: 5 attempts per 15-minute window; locked for 1 hour after exceeding threshold.';

-- RLS: service role only (edge function uses SUPABASE_SERVICE_ROLE_KEY)
ALTER TABLE password_reset_rate_limit ENABLE ROW LEVEL SECURITY;

-- No public policies — only the service role key (used by the edge function) can access this table.
