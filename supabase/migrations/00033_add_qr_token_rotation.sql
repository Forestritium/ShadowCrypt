-- QR contact-exchange token rotation
-- qr_token:         random nonce embedded in the QR payload (rotated on schedule or manually)
-- qr_generated_at:  when the current token was generated (for client-side expiry check)
-- qr_rotation_days: how often the token should rotate (1–14, default 3)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS qr_token          text          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS qr_generated_at   timestamptz   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS qr_rotation_days  smallint      DEFAULT 3
    CHECK (qr_rotation_days BETWEEN 1 AND 14);

COMMENT ON COLUMN profiles.qr_token         IS 'Rotating nonce for QR contact exchange — embedded in QR payload to limit reuse lifetime.';
COMMENT ON COLUMN profiles.qr_generated_at  IS 'Timestamp when the current qr_token was issued.';
COMMENT ON COLUMN profiles.qr_rotation_days IS 'Auto-rotation interval in days (1–14, default 3). Controlled by the user.';