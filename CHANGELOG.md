# Changelog

All notable changes to ShadowCrypt are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **Voice messages** — Record and send end-to-end encrypted voice messages directly in the chat.
  - Audio encoded with the Opus codec in a WebM container at 32 kbps Constrained VBR (CVBR), providing efficient compression while bounding the bitrate ceiling.
  - Each recording is encrypted client-side with AES-256-GCM (random 256-bit key + 12-byte IV) before upload; plaintext audio never leaves the browser.
  - The per-recording AES key is embedded in the Double Ratchet ciphertext (v:3 payload) and vault-wrapped before database storage — the relay and storage layer see only opaque blobs.
  - Voice blobs stored in a private Supabase Storage bucket (`chat-voices`); served via short-lived signed URLs (1-hour expiry).
  - Rate limit: **10 minutes of voice per user per day** (resets at midnight UTC), enforced server-side via the `voice_send_durations` table and `increment_voice_send_duration` RPC.
  - `VoiceRecordButton` component: tap to start/stop recording; displays live elapsed timer and cancel option.
  - `VoiceMessageBubble` component: inline audio player with play/pause, scrub bar, and duration display; audio decrypted lazily on first play.
  - `VoiceLimitDialog`: shown when the daily quota is exceeded, with reset time.
  - New database columns on `messages`: `voice_storage_path`, `voice_key_b64`, `voice_duration_seconds`.

---

## [1.0.0] — 2025

### Added

#### Core Cryptography
- AES-256-GCM message and vault encryption via the Web Crypto API.
- ECDH P-256 key pair generation per user for key exchange.
- HKDF-SHA256 for key derivation within the Double Ratchet.
- HMAC-SHA256 chain key advancement in the symmetric ratchet.
- Argon2id (64 MB, 3 iterations) vault key derivation (KDF v1) via `hash-wasm`.
- PBKDF2-SHA256 (310,000 iterations) legacy vault key derivation (KDF v0).
- Automatic KDF migration: v0 users are prompted to migrate to v1 on first login.

#### Signal Protocol Double Ratchet
- Full Double Ratchet implementation (simplified Signal Protocol).
- ECDH ratchet step on each message header containing a new ephemeral key.
- Symmetric-key ratchet for per-message key derivation (forward secrecy).
- Skipped-message key storage (up to 1,000 keys) for out-of-order delivery.

#### Authentication & Password System
- Username + password authentication backed by Supabase Auth.
- Password requirements: 6–20 characters, uppercase, lowercase, number, special character.
- Live password requirements checklist and zxcvbn strength meter on registration.
- BIP-39 12-word mnemonic recovery phrase generated on registration.
- Mnemonic hash (SHA-256) stored in `profiles.mnemonic_hash` for server-side verification.
- Forgot password flow: mnemonic verification via `reset-password` Edge Function.
- Account migration modal for users upgrading from legacy 6-digit PIN authentication.

#### Messaging
- Real-time encrypted messaging via Supabase Realtime.
- Relay table: ciphertext-only, messages auto-deleted from relay after 30 days.
- Local message history stored in encrypted IndexedDB vault (AES-256-GCM).
- Reply-to / quote: thread-aware message replies with visual preview.
- Image sharing: upload to Supabase Storage with 10 images/day per user rate limit.
- Anonymous push notifications (never reveals sender identity).
- Audio notification sound on incoming messages.

#### Contacts & Social
- Contact request system (send / accept / decline).
- Outgoing request cancellation before acceptance.
- Contact removal with bilateral relay cleanup.
- Block / unblock users.
- Public key fingerprint display for out-of-band verification.

#### Profile & Settings
- Username (3–32 chars; change once every 30 days).
- Bio (max 160 characters).
- Avatar upload (max 2 MB; privacy toggle to hide from non-contacts).
- Recovery phrase viewer and regenerate option in Settings.
- Blocked users list management.
- Account deletion via Edge Function (cascades all user data).

#### UI / UX
- Dark and light theme with system preference detection.
- Fully responsive: desktop sidebar + mobile Sheet navigation.
- Splash screen on initial load.
- Privacy Policy page.
- 404 Not Found page.
- Sonner toast notifications throughout.

#### Infrastructure
- Supabase backend: PostgreSQL, Auth, Realtime, Storage, Edge Functions.
- Row-Level Security on all tables.
- 18 ordered SQL migration files.
- `delete-account` Edge Function (admin-privilege user deletion).
- `reset-password` Edge Function (mnemonic-verified password reset).
- Progressive Web App manifest and service worker.
- Biome linting + TypeScript strict mode.
- Conventional Commits on all changes.
- Auto-push to private and sanitised public repository on every commit.

---

[Unreleased]: https://github.com/Forestritium/ShadowCrypt/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Forestritium/ShadowCrypt/releases/tag/v1.0.0
