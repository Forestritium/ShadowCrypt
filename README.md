<div align="center">
  <img src="public/images/logo/logo-dark.svg" alt="ShadowCrypt Logo" width="80" />
  <h1>ShadowCrypt</h1>
  <p><strong>End-to-end encrypted messaging with a zero-knowledge relay</strong></p>

  [![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
  [![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org)
  [![Supabase](https://img.shields.io/badge/Supabase-Backend-3ECF8E?logo=supabase)](https://supabase.com)
</div>

---

## What is ShadowCrypt?

ShadowCrypt is an **end-to-end encrypted** messaging app built on a **zero-knowledge relay**: the server routes opaque ciphertext between clients and never holds keys, plaintext, or anything that would allow decryption. All cryptographic operations happen entirely in the browser using the Web Crypto API and audited WebAssembly libraries.

- **End-to-end encrypted** messages using the Signal Protocol Double Ratchet (X25519 + HKDF-SHA256 + AES-256-GCM)
- **Vault encryption** of all local data with Argon2id-derived keys
- **BIP-39 mnemonic recovery** for password resets without server involvement
- **Zero plaintext at rest** — the Supabase database only ever stores opaque ciphertext

> **Transparency note — message headers**: The Double Ratchet envelope header (`senderPublicKey`, `messageNumber`, `prevChainLength`) travels in cleartext. This is a deliberate simplification: full Signal-style header encryption requires a separate header-key ratchet and is deferred to a future release. The metadata leak is limited to the DH ratchet public key and per-conversation counters — message content is always fully encrypted.

---

## Features

| Feature | Details |
|---|---|
| 🔐 **End-to-End Encryption** | Double Ratchet (Signal Protocol) — per-message unique keys, full forward secrecy |
| 🗝️ **Vault Encryption** | All local data (messages, contacts, sessions) encrypted with Argon2id + AES-256-GCM |
| 📨 **Real-time Messaging** | Supabase Realtime relay — ciphertext only, messages deleted after delivery |
| 🖼️ **Image Sharing** | Encrypted image upload to Supabase Storage, 10 images/day per user |
| 💬 **Reply & Quote** | Thread-aware reply with quoted message preview |
| 👥 **Contact Requests** | Accept/decline incoming requests; full block list management |
| 🔑 **Recovery Phrase** | BIP-39 12-word mnemonic for password reset without email |
| 🔒 **Password Strength** | zxcvbn-based strength estimation + live requirements checklist |
| 🌙 **Dark / Light Mode** | System-aware theme with manual override |
| 📱 **Responsive** | Full desktop + mobile experience |
| 🔔 **Notifications** | Anonymous push notifications — never reveals sender identity |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui |
| **Cryptography** | Web Crypto API, hash-wasm (Argon2id), @scure/bip39 |
| **Backend** | Supabase (Postgres, Auth, Realtime, Storage, Edge Functions) |
| **Key Exchange** | ECDH P-256 |
| **Message Encryption** | Signal Protocol Double Ratchet (AES-256-GCM + HKDF-SHA256) |
| **Vault KDF** | Argon2id (v1) / PBKDF2-SHA256 @ 310k iterations (v0 legacy) |
| **Password Recovery** | BIP-39 (128-bit entropy, 12 words) |

---

## Quick Start

### Prerequisites

- Node.js ≥ 18
- pnpm ≥ 8
- A [Supabase](https://supabase.com) project

### 1. Clone & Install

```bash
git clone https://github.com/Forestritium/ShadowCrypt.git
cd ShadowCrypt
pnpm install
```

### 2. Configure Environment

Copy the template and fill in your Supabase credentials:

```bash
cp .env.example .env
```

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
VITE_APP_ID=your-app-id
```

### 3. Apply Database Migrations

```bash
supabase db push
# or apply each file in supabase/migrations/ in order
```

### 4. Deploy Edge Functions

```bash
supabase functions deploy delete-account
supabase functions deploy reset-password
```

### 5. Run Locally

```bash
pnpm dev
```

---

## Repository Structure

```
ShadowCrypt/
├── src/
│   ├── components/
│   │   ├── chat/          # Chat UI (Sidebar, ChatArea, dialogs)
│   │   ├── common/        # RouteGuard, PageMeta
│   │   └── ui/            # shadcn/ui primitives
│   ├── contexts/
│   │   ├── AuthContext.tsx   # Auth state, vault unlock, mnemonic management
│   │   └── ThemeContext.tsx  # Dark/light theme
│   ├── lib/
│   │   ├── crypto.ts         # AES-GCM, ECDH, HKDF, PBKDF2, Argon2id
│   │   ├── doubleRatchet.ts  # Signal Protocol Double Ratchet
│   │   ├── relay.ts          # Supabase messaging relay
│   │   ├── localStore.ts     # Encrypted IndexedDB vault
│   │   ├── dbStore.ts        # Supabase contacts & messages store
│   │   ├── session.ts        # Session lifecycle, key derivation
│   │   ├── mnemonic.ts       # BIP-39 utilities
│   │   └── zxcvbn.ts         # Password strength estimation
│   ├── pages/
│   │   ├── AuthPage.tsx      # Login, register, migrate, forgot password
│   │   ├── ChatPage.tsx      # Main chat interface
│   │   ├── SettingsPage.tsx  # Profile, bio, avatar, recovery phrase
│   │   └── PrivacyPolicyPage.tsx
│   └── types/types.ts        # Shared TypeScript types
├── supabase/
│   ├── functions/
│   │   ├── delete-account/   # Admin-privilege account deletion
│   │   └── reset-password/   # Mnemonic-verified password reset
│   └── migrations/           # Ordered SQL migration files
└── public/                   # Static assets
```

---

## Security Model

ShadowCrypt is built on a **zero-knowledge** principle:

1. **Message encryption** — Every message is encrypted with a unique per-message key before leaving the device. The server routes ciphertext only and deletes it after delivery.

2. **Vault encryption** — All locally-stored data (messages, contacts, ratchet sessions, identity keys) is encrypted in IndexedDB using AES-256-GCM with a key derived from the user's password via Argon2id.

3. **Key exchange** — ECDH P-256 public keys are stored in Supabase profiles. The private key never leaves the device.

4. **Forward secrecy** — The Double Ratchet advances the chain key after every message. Compromise of one message key does not expose past or future messages.

5. **Password recovery** — A BIP-39 mnemonic is generated locally on registration. Its SHA-256 hash is stored on the server. The server verifies the mnemonic hash and resets the auth password without ever seeing the mnemonic itself.

For a full threat model and responsible disclosure policy, see [SECURITY.md](SECURITY.md).

---

## Contributing

We welcome contributions! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

---

## License

ShadowCrypt is licensed under the **GNU Affero General Public License v3.0**. See [LICENSE](LICENSE) for details.

> Under the AGPL, if you modify ShadowCrypt and run it as a network service, you must release your modifications under the same license.
