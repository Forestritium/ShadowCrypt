
-- ─────────────────────────────────────────────────────────────────────────────
-- Add QR-verification and original-fingerprint tracking to contacts.
--
-- verified_via_qr: true  = Alice scanned Bob's QR in-person and the fingerprint
--                          embedded in the QR matched the server's public key at
--                          scan time — strongest trust level.
--                 false  = contact was added via username search (TOFU).
--
-- original_fingerprint: hex SHA-256 of Bob's public key at the moment Alice
--                        first added him.  Never overwritten by key refreshes so
--                        it serves as the "trusted baseline" fingerprint.
--                        A key change is detected when the live key's fingerprint
--                        no longer matches this stored value.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS verified_via_qr   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS original_fingerprint text;

-- Back-fill original_fingerprint from the existing fingerprint column so that
-- existing contacts get a baseline for key-change detection immediately.
UPDATE contacts
   SET original_fingerprint = fingerprint
 WHERE original_fingerprint IS NULL
   AND fingerprint IS NOT NULL;
