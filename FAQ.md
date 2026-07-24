# SylvaCrypt FAQ

Welcome to the SylvaCrypt FAQ! Here you will find answers to the most common questions about our Zero-Knowledge Messaging Platform.

## General

**What is SylvaCrypt?**
SylvaCrypt (formerly ShadowCrypt) is a secure, end-to-end encrypted messaging platform. It uses advanced cryptographic protocols (including Post-Quantum cryptography) to ensure that your messages remain private and secure.

**Is my data really private?**
Yes. SylvaCrypt employs a zero-knowledge architecture. All messages are encrypted locally on your device before they are sent to the server. We do not have the keys to decrypt your messages.

## Security & Encryption

**What encryption protocols does SylvaCrypt use?**
SylvaCrypt uses the Signal Protocol's Double Ratchet algorithm combined with Post-Quantum (ML-KEM-768) encapsulation to ensure forward secrecy and post-quantum security. We also use Ed25519 for identity verification and AES-256-GCM for symmetric message encryption.

**What is the Safety Number?**
The safety number is a 60-digit fingerprint generated from your public key and your contact's public key. By verifying this number with your contact (e.g., over a phone call or in person), you can ensure that your conversation is secure and has not been intercepted by a man-in-the-middle.

**How often do encryption keys rotate?**
With every single message sent and received, the encryption keys are rotated using the Double Ratchet algorithm, providing perfect forward secrecy.

## Account & Devices

**Can I use multiple devices?**
Yes, SylvaCrypt supports linking multiple devices. Each device maintains its own independent end-to-end encrypted sessions with your contacts.

**What happens if I lose my device?**
If you lose your device, you can log in from a new device using your credentials and your master recovery key. However, because we do not store your message history in plain text, you will only be able to see new messages unless you restore a backup from a secure local vault.

## Troubleshooting

**Why did my secure session reset?**
Sessions can occasionally reset if there is an unrecoverable mismatch in the Double Ratchet state (for example, if a device goes offline for a very long time and misses too many messages). The app will automatically fall back to an X3DH handshake to establish a fresh, secure session without requiring manual intervention.

**Who do I contact for support?**
If you encounter any issues not covered here, please reach out via our official support channels or open an issue on our GitHub repository.
