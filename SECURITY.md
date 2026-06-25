# Security Policy

## Overview

ShadowCrypt is built around a zero-knowledge security model. This document describes the threat model, cryptographic design, known limitations, and the responsible disclosure process.

---

## Supported Versions

| Version | Supported |
|---|---|
| Latest (`main`) | ✅ Active security support |
| Older releases | ❌ No longer maintained |

Always run the latest version.

---

## Threat Model

### What ShadowCrypt protects against

| Threat | Mitigation |
|---|---|
| **Server compromise** | The server only stores encrypted ciphertext. It cannot read messages, contacts, or identity keys. |
| **Database leak** | All message content is AES-256-GCM encrypted before being written to Supabase. A raw DB dump reveals only opaque blobs. |
| **Man-in-the-middle on the relay** | Messages are encrypted end-to-end with the Double Ratchet before being sent to the relay. The relay only routes ciphertext. |
| **Retrospective decryption** | The Double Ratchet provides full forward secrecy. Each message uses a unique derived key. Compromise of one key does not expose past or future messages. |
| **Weak passwords** | Argon2id (64 MB memory, 3 iterations) is used for vault key derivation — GPU/ASIC cracking is computationally expensive. |
| **Password reset without email** | BIP-39 mnemonic is verified by SHA-256 hash comparison server-side. The mnemonic itself is never sent to or stored on the server. |
| **Notification metadata** | Browser notifications are anonymous — they never reveal the sender's identity or message content. |

### What ShadowCrypt does NOT protect against

| Threat | Explanation |
|---|---|
| **Compromised device / malware** | If the device running ShadowCrypt is compromised, an attacker can read decrypted messages from memory. |
| **Session hijacking** | A stolen Supabase JWT allows an attacker to receive future encrypted messages as the victim — but cannot decrypt them without the vault key. |
| **Browser extension attacks** | Malicious browser extensions with access to the page context can intercept plaintext before encryption. |
| **Physical access** | The vault key is held in `sessionStorage` during an active session for usability. Physical or OS-level access to the browser could expose it. |
| **Metadata analysis** | ShadowCrypt hides message content but not the fact that two users are communicating or the frequency of communication. |
| **Denial of Service** | No specific DDoS mitigations are implemented at the application level. |

---

## Cryptographic Design

### Key Derivation

| Version | Algorithm | Parameters |
|---|---|---|
| v1 (current) | **Argon2id** | memory=64 MB, iterations=3, parallelism=1, output=32 bytes |
| v0 (legacy) | **PBKDF2-SHA256** | 310,000 iterations, output=32 bytes |

New accounts always use v1. v0 accounts are prompted to migrate on first login.

### Message Encryption

ShadowCrypt implements a simplified Signal Protocol **Double Ratchet**:

- **DH Ratchet**: ECDH P-256 key pairs. Each ratchet step advances the root key.
- **KDF Chain**: HMAC-SHA256-based symmetric ratchet for per-message key derivation.
- **Message encryption**: AES-256-GCM with a 12-byte random IV prepended to ciphertext.
- **Initialisation**: ECDH shared secret → HKDF-SHA256 → initial root key.

### Vault Encryption

All data in IndexedDB is encrypted as individual JSON blobs:
- Format: `base64(IV[12] + AES-256-GCM-ciphertext)`
- Key: derived from the user's password via Argon2id (stored in memory only during session; exported to `sessionStorage` as raw bytes for tab-reload recovery).

### Identity Keys

- ECDH P-256 key pair generated in-browser on first registration.
- Public key stored in Supabase `profiles` table.
- Private key stored encrypted in the local vault (never transmitted).

### Recovery Phrase

- 12-word BIP-39 mnemonic (128-bit entropy) generated on registration.
- `SHA-256(normalised_mnemonic)` stored in `profiles.mnemonic_hash`.
- The mnemonic itself is stored **encrypted in the local vault only**.
- Password reset flow: client sends mnemonic → server hashes and compares → if match, admin password reset is performed.

---

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

To report a security issue responsibly:

1. **Email**: Send a detailed report to the maintainer's contact listed on the GitHub profile of [A-Solo-Engineer](https://github.com/A-Solo-Engineer).
2. **Include**:
   - Description of the vulnerability.
   - Affected component(s) and version(s).
   - Steps to reproduce.
   - Potential impact assessment.
   - Any suggested mitigations (optional but appreciated).
3. **Encryption**: If the report contains sensitive details, request a PGP key before sending.

### Response Timeline

| Stage | Target |
|---|---|
| Acknowledgement | Within 72 hours |
| Initial assessment | Within 7 days |
| Fix or mitigation | Within 30 days (critical), 90 days (moderate) |
| Public disclosure | Coordinated with reporter after fix is deployed |

We follow [responsible disclosure](https://cheatsheetseries.owasp.org/cheatsheets/Vulnerability_Disclosure_Cheat_Sheet.html). Reporters who follow this process will be credited (unless they prefer anonymity).

---

## Known Limitations

1. **sessionStorage vault key** — The derived vault key is written to `sessionStorage` to survive page reloads within the same browser tab. This is a deliberate usability tradeoff. Users on shared or untrusted machines should log out and close the tab when finished.

2. **No perfect forward secrecy for stored messages** — Forward secrecy applies to the relay (messages deleted after delivery). Messages stored in the local encrypted IndexedDB vault are all protected by the same vault key. If the vault key is compromised, all stored messages are exposed.

3. **Daily image limit** — The 10 images/day cap is enforced server-side via a Postgres function. It mitigates storage abuse but is not a security boundary.

4. **Self-hosted deployments** — If you self-host ShadowCrypt, you are responsible for securing your Supabase project, applying migrations, and keeping dependencies up to date.
