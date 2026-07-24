/**
 * End-to-end encrypted push payloads.
 *
 * The sender encrypts the notification title/body with an ephemeral X25519 key
 * and the recipient's public key. The Edge Function forwards the ciphertext
 * without reading it; the recipient's Service Worker decrypts it using the
 * corresponding private key stored in the device.
 */

import { toBase64, fromBase64, ab, x25519DH } from '@/lib/crypto';
import { x25519 } from '@noble/curves/ed25519.js';

interface EncryptedPushPayload {
  /** Base64-encoded ephemeral X25519 public key. */
  ephPub: string;
  /** Base64-encoded 12-byte AES-GCM IV. */
  iv: string;
  /** Base64-encoded 32-byte HKDF Salt. */
  salt: string;
  /** Base64-encoded AES-GCM ciphertext of the JSON payload. */
  ciphertext: string;
}

function deriveSharedSecret(ephemeralPriv: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  return x25519DH(toBase64(ephemeralPriv), toBase64(recipientPub));
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ab(ikm), 'HKDF', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: ab(salt), info: ab(new TextEncoder().encode(info)) },
    key,
    length * 8
  );
  return new Uint8Array(derived);
}

async function aesEncrypt(key: CryptoKey, data: Uint8Array): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(iv) }, key, ab(data));
  return { ciphertext: new Uint8Array(cipher), iv };
}

async function aesDecrypt(key: CryptoKey, ciphertext: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(iv) }, key, ab(ciphertext));
  return new Uint8Array(plain);
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', ab(raw), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt a push payload for a recipient.
 * @param recipientPublicKey - recipient's X25519 public key (base64)
 * @param payload - serialisable push payload object
 */
export async function encryptPushPayload(
  recipientPublicKey: string,
  payload: Record<string, unknown>
): Promise<EncryptedPushPayload> {
  const ephPriv = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = deriveSharedSecret(ephPriv, fromBase64(recipientPublicKey));
  const randomSalt = crypto.getRandomValues(new Uint8Array(32));
  const keyBytes = await hkdf(shared, randomSalt, 'SylvaCrypt-Push-v1', 32);
  const key = await importKey(keyBytes);
  const { ciphertext, iv } = await aesEncrypt(key, new TextEncoder().encode(JSON.stringify(payload)));
  return {
    ephPub: toBase64(ephPub),
    iv: toBase64(iv),
    salt: toBase64(randomSalt),
    ciphertext: toBase64(ciphertext),
  };
}

/**
 * Decrypt a push payload using the recipient's X25519 private key.
 */
export async function decryptPushPayload(
  encrypted: EncryptedPushPayload,
  recipientPrivateKeyBase64: string
): Promise<Record<string, unknown>> {
  const shared = deriveSharedSecret(fromBase64(recipientPrivateKeyBase64), fromBase64(encrypted.ephPub));
  const saltBytes = encrypted.salt ? fromBase64(encrypted.salt) : new Uint8Array(32); // Fallback for old pushes without salt
  const keyBytes = await hkdf(shared, saltBytes, 'SylvaCrypt-Push-v1', 32);
  const key = await importKey(keyBytes);
  const plain = await aesDecrypt(key, fromBase64(encrypted.ciphertext), fromBase64(encrypted.iv));
  return JSON.parse(new TextDecoder().decode(plain));
}

