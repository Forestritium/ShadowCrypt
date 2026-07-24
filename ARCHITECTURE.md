# ShadowCrypt — Architecture

This document describes the technical architecture of ShadowCrypt, covering the frontend, backend, cryptographic stack, and data flow.

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Browser (Client)                              │
│                                                                        │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │  React + TypeScript + Vite                                     │   │
│  │                                                                 │   │
│  │  AuthContext ──► session.ts ──► localStore.ts (IndexedDB)     │   │
│  │       │               │                                        │   │
│  │       ▼               ▼                                        │   │
│  │  AuthPage.tsx    crypto.ts (Web Crypto API + hash-wasm)       │   │
│  │  ChatPage.tsx         │                                        │   │
│  │  SettingsPage.tsx     ▼                                        │   │
│  │                 doubleRatchet.ts ──► relay.ts                 │   │
│  │                                         │                      │   │
│  └─────────────────────────────────────────┼──────────────────────┘  │
│                                            │                           │
└────────────────────────────────────────────┼───────────────────────────┘
                                             │ HTTPS / WSS
                                             │ (ciphertext only)
                             ┌───────────────▼──────────────┐
                             │         Supabase             │
                             │                              │
                             │  ┌──────────────────────┐   │
                             │  │  PostgreSQL (DB)      │   │
                             │  │  - profiles           │   │
                             │  │  - contacts           │   │
                             │  │  - messages (relay)   │   │
                             │  │  - contact_requests   │   │
                             │  └──────────────────────┘   │
                             │  ┌──────────────────────┐   │
                             │  │  Realtime            │   │
                             │  │  (change feed for    │   │
                             │  │   relay messages)    │   │
                             │  └──────────────────────┘   │
                             │  ┌──────────────────────┐   │
                             │  │  Storage             │   │
                             │  │  (encrypted images,  │   │
                             │  │   encrypted voices)  │   │
                             │  └──────────────────────┘   │
                             │  ┌──────────────────────┐   │
                             │  │  Edge Functions      │   │
                             │  │  - delete-account    │   │
                             │  │  - reset-password    │   │
                             │  └──────────────────────┘   │
                             └──────────────────────────────┘
```

---

## Frontend Architecture

### Layer Responsibilities

| Layer | Path | Responsibility |
|---|---|---|
| **Pages** | `src/pages/` | Route-level components: AuthPage, ChatPage, SettingsPage |
| **Contexts** | `src/contexts/` | Global state: auth/session (AuthContext), theme (ThemeContext) |
| **Components** | `src/components/` | UI building blocks: chat panels, dialogs, shadcn/ui primitives |
| **Lib** | `src/lib/` | Pure logic: crypto, ratchet, relay, vault, mnemonic |
| **DB** | `src/db/` | Supabase client singleton |
| **Hooks** | `src/hooks/` | Reusable React hooks |
| **Types** | `src/types/` | Shared TypeScript interfaces |

### State Management

ShadowCrypt does not use a global state library (no Redux, Zustand, etc.). State is managed via:

- **React Context** — `AuthContext` for user/profile/session, `ThemeContext` for theme.
- **Component-local state** — `useState` / `useReducer` within page/component.
- **In-memory singletons** — `localStore.ts` holds the vault key and IndexedDB handle in module scope.

### Routing

React Router v7 with the following routes:

| Path | Component | Guard |
|---|---|---|
| `/` | Redirects to `/chat` | Authenticated |
| `/auth` | `AuthPage` | Public |
| `/chat` | `ChatPage` | Authenticated |
| `/settings` | `SettingsPage` | Authenticated |
| `/privacy` | `PrivacyPolicyPage` | Public |
| `*` | `NotFound` | Public |

`RouteGuard` redirects unauthenticated users to `/auth`.

---

## Cryptographic Stack

### Vault Key Derivation

```
User password
      │
      ▼
Argon2id (mem=64MB, iter=3, par=1)    ← KDF v1 (new accounts)
      │
      ▼
32-byte raw key
      │
      ▼
AES-256-GCM CryptoKey (non-extractable in use, except for sessionStorage backup)
```

Legacy accounts use PBKDF2-SHA256 (310,000 iterations) for v0 keys and are migrated on first login.

### Vault Storage

```
IndexedDB "shadowcrypt_local"
  encrypted_store {
    key: "identity_keypair"      → base64(IV + AES-GCM(json({publicKeyBase64, privateKeyBase64})))
    key: "salt"                  → base64(16-byte random salt)
    key: "kdf_version"           → base64(IV + AES-GCM(json(number)))
    key: "ratchet:{convId}"      → base64(IV + AES-GCM(json(RatchetSession)))
    key: "mnemonic"              → base64(IV + AES-GCM(json(string)))
  }
```

### Message Encryption (Double Ratchet)

```
                 Alice                              Bob
                   │                                │
  ┌────────────────▼────────────────┐               │
  │  initSessionSender              │               │
  │  ECDH(alice_eph_priv, bob_pub)  │               │
  │  → shared secret                │               │
  │  → initial root key (RK)        │               │
  │  → sending chain key (CKs)      │               │
  └────────────────┬────────────────┘               │
                   │                                │
  ┌────────────────▼────────────────┐               │
  │  ratchetEncrypt(plaintext)      │               │
  │  kdfCK(CKs) → (CKs', MK)       │               │
  │  AES-256-GCM(MK, plaintext)     │               │
  │  → EncryptedEnvelope            │               │
  └────────────────┬────────────────┘               │
                   │  EncryptedEnvelope (relay)      │
                   └────────────────────────────────►│
                                    ┌────────────────▼────────────────┐
                                    │  ratchetDecrypt(envelope)       │
                                    │  (DH ratchet if new DHs key)    │
                                    │  kdfCK(CKr) → (CKr', MK)       │
                                    │  AES-256-GCM-decrypt(MK, ct)    │
                                    └─────────────────────────────────┘
```

### Recovery Phrase

```
Registration:
  generateMnemonic()          → 12-word BIP-39 phrase
  hashMnemonic(phrase)        → SHA-256 hex string
  store SHA-256 hash          → profiles.mnemonic_hash (Supabase)
  store phrase encrypted      → vault IndexedDB key "mnemonic"

Reset flow:
  user submits phrase
  Edge Function: hashMnemonic(input) == profiles.mnemonic_hash?
    Yes → adminClient.auth.admin.updateUserById(newPassword)
    No  → return 400 error
```

---

## Backend Architecture

### Supabase Tables

| Table | Purpose |
|---|---|
| `profiles` | username, public_key, bio, avatar_url, avatar_private, password_version, mnemonic_hash, kdf_version, vault_backup |
| `contacts` | owner_id → contact_id mapping; denormalised username + public_key for offline access |
| `messages` | Relay table: encrypted ciphertext routed between users, auto-deleted after 30 days |
| `voice_send_durations` | Tracks total voice message seconds sent per user per UTC day (10-minute daily cap) |
| `contact_requests` | Pending/accepted/declined add-contact requests |
| `blocked_users` | Bidirectional block records |

### Row-Level Security

All tables use RLS policies. Key rules:

- **profiles** — users can only read their own profile and profiles of their contacts.
- **messages** — users can only read messages addressed to them; only the sender can insert.
- **contacts** — users can only read and modify their own contact list.
- **contact_requests** — sender and recipient can each read their side of the request.

### Edge Functions

| Function | Trigger | Description |
|---|---|---|
| `delete-account` | Client call (authenticated JWT) | Verifies JWT, uses service-role key to call `admin.deleteUser()`. Cascades delete all user data via FK constraints. |
| `reset-password` | Client call (no auth required) | Verifies BIP-39 mnemonic hash, uses service-role key to call `admin.updateUserById()` with new password. |

### Realtime

Supabase Realtime is subscribed to the `messages` table on the `relay` channel (filtered by `recipient_id`). Incoming encrypted envelopes are decrypted client-side after delivery.

---

## Data Flow: Sending a Message

```
1. User types message → ChatArea
2. relay.sendEncryptedMessage(conversationId, plaintext)
3.   localStore.getRatchetSession(conversationId) → session
4.   doubleRatchet.ratchetEncrypt(session, plaintext)
5.     kdfCK(CKs) → (CKs', MK)
6.     AES-256-GCM(MK, UTF8(plaintext)) → ciphertext + iv
7.     Build EncryptedEnvelope { senderDHPub, Ns, PN, iv, ciphertext }
8.   localStore.saveRatchetSession(conversationId, updatedSession)
9.   supabase.from('messages').insert(envelope)         ← relay
10.  dbStore.saveMessageToDBFull(localMessage)          ← local vault
11. Supabase Realtime pushes row to recipient
12. Recipient: relay.receiveAndDecryptMessage(envelope)
13.   doubleRatchet.ratchetDecrypt(session, envelope)
14.   Returns plaintext → stored in local vault + rendered in UI
```

## Data Flow: Sending a Voice Message

```
1. User taps mic button → VoiceRecordButton starts MediaRecorder
   - Codec: Opus (Constrained VBR, 32 kbps ceiling) in WebM container
   - Chunk interval: 250 ms
2. User taps stop → MediaRecorder.stop() → Blob (audio/webm)
3. relay.uploadVoiceMessage(userId, blob, durationSeconds, mimeType)
4.   Rate-limit check: get_voice_send_duration(userId) → usedSeconds
     If usedSeconds + durationSeconds > 600 → throw VoiceLimitError
5.   encryptFileAESGCM(blob) → { ciphertextBlob, keyBase64 }
     - Generates random 256-bit AES key + 12-byte IV
     - IV prepended to ciphertext
6.   supabase.storage.from('chat-voices').upload(path, ciphertextBlob)
     - Bucket: private, no public access, signed URLs only
7.   increment_voice_send_duration(userId, durationSeconds)
8.   Returns { storagePath, voiceKeyBase64, voiceDuration }
9. relay.sendEncryptedMessage(..., voiceAttachment)
   - ratchetPlaintext = JSON.stringify({ v:3, t:'', vsp, vk, vd })
   - Double Ratchet encrypts → voiceKey travels securely in ciphertext
10. dbStore.saveMessageToDBFull(localMessage)
    - voiceKeyBase64 vault-wrapped before DB write

Playback (recipient):
11. Receive ratchet-decrypted { v:3, vsp, vk, vd } payload
12. VoiceMessageBubble: on first play, fetchAndDecryptVoiceMessage(vsp, vk)
13.   createSignedUrl(vsp, 3600) → signed URL (1-hour expiry)
14.   fetch(signedUrl) → ciphertextBlob
15.   decryptBlobAESGCM(ciphertextBlob, vk) → ArrayBuffer (plaintext audio)
16.   URL.createObjectURL(new Blob([plainbuf], { type:'audio/webm' }))
17.   <audio> element plays — plaintext audio never leaves the browser
```

---

## Key Design Decisions

1. **No server-side message storage** — Messages are deleted from the relay after delivery (30-day hard cap via pg_cron). Long-term message history is stored encrypted in the client's IndexedDB vault.

2. **Argon2id over bcrypt/scrypt** — Argon2id provides memory-hardness (resists GPU/ASIC attacks) and is the winner of the Password Hashing Competition. hash-wasm provides a WASM port that runs in-browser without native dependencies.

3. **BIP-39 over email recovery** — Email-based recovery requires a trusted server and exposes the user's email address. BIP-39 recovery is fully client-initiated and does not require any PII.

4. **ECDH P-256** — Chosen for native Web Crypto API support (no polyfill). Future versions may migrate to X25519.

5. **Supabase as a zero-knowledge relay** — Supabase is used purely as a transport and auth layer. It never holds decryption keys, so a full Supabase compromise reveals only ciphertext.
