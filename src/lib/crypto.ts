/**
 * Cryptographic primitives for ShadowCrypt.
 *
 * Key exchange:   X25519 (via @noble/curves) — constant-time, audited, no Web Crypto ECDH dependency
 * Vault KDF:      Argon2id v1 (memory-hard) / PBKDF2-SHA256 v0 (legacy)
 * Encryption:     AES-256-GCM (Web Crypto API)
 * KDF chain:      HKDF-SHA256, HMAC-SHA256
 */

import { argon2id } from 'hash-wasm';
import { x25519 } from '@noble/curves/ed25519.js';

// ─── Encoding helpers ────────────────────────────────────────────────────────

/** Cast Uint8Array to plain ArrayBuffer for WebCrypto compatibility. */
export function ab(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ─── Vault key derivation ────────────────────────────────────────────────────

/** Derive AES-256 vault key from password — PBKDF2-SHA256 (KDF v0, legacy). */
export async function deriveKeyFromPassword(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', ab(new TextEncoder().encode(password)), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: ab(salt), iterations: 310000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
  );
}

/** Derive AES-256 vault key from password — Argon2id (KDF v1, memory-hard). */
export async function deriveKeyFromPasswordArgon2id(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = await argon2id({
    password, salt,
    parallelism: 1, iterations: 3, memorySize: 65536,
    hashLength: 32, outputType: 'binary',
  });
  return crypto.subtle.importKey(
    'raw', ab(raw as Uint8Array),
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
  );
}

/** Route to the correct KDF based on stored version. */
export async function deriveVaultKey(password: string, salt: Uint8Array, kdfVersion: number): Promise<CryptoKey> {
  return kdfVersion >= 1
    ? deriveKeyFromPasswordArgon2id(password, salt)
    : deriveKeyFromPassword(password, salt);
}

// ─── AES-256-GCM ─────────────────────────────────────────────────────────────

/** Encrypt bytes with AES-256-GCM; returns ciphertext and a fresh 12-byte IV. */
export async function aesEncrypt(key: CryptoKey, data: Uint8Array): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer }, key, ab(data)
  );
  return { ciphertext: new Uint8Array(ciphertext), iv };
}

/** Decrypt AES-256-GCM ciphertext. */
export async function aesDecrypt(key: CryptoKey, ciphertext: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer }, key, ab(ciphertext)
  );
  return new Uint8Array(plain);
}

/** Encrypt any JSON-serialisable value; returns base64(IV[12] + ciphertext). */
export async function encryptObject<T>(key: CryptoKey, obj: T): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const { ciphertext, iv } = await aesEncrypt(key, data);
  const out = new Uint8Array(12 + ciphertext.length);
  out.set(iv); out.set(ciphertext, 12);
  return toBase64(out);
}

/** Decrypt base64(IV[12] + ciphertext) back to T. */
export async function decryptObject<T>(key: CryptoKey, encoded: string): Promise<T> {
  const combined = fromBase64(encoded);
  const plain = await aesDecrypt(key, combined.slice(12), combined.slice(0, 12));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** Import raw bytes as a non-extractable AES-GCM CryptoKey. */
export async function importAESKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', ab(bytes), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ─── X25519 key exchange ──────────────────────────────────────────────────────
//
// X25519 replaces ECDH P-256 throughout the ratchet.
// Advantages: constant-time scalar multiplication, ~8× smaller keys (32 bytes raw
// vs 65 bytes uncompressed P-256), no Web Crypto ECDH dependency, formally audited
// via @noble/curves.

/** Generate a fresh X25519 key pair; returns base64-encoded raw bytes. */
export function generateX25519KeyPair(): { privateKeyBase64: string; publicKeyBase64: string } {
  const priv = x25519.utils.randomSecretKey();
  const pub  = x25519.getPublicKey(priv);
  return { privateKeyBase64: toBase64(priv), publicKeyBase64: toBase64(pub) };
}

/** Derive the X25519 public key from a base64-encoded private key. */
export function x25519PublicKeyFromPrivate(privateKeyBase64: string): string {
  return toBase64(x25519.getPublicKey(fromBase64(privateKeyBase64)));
}

/** Perform an X25519 DH operation; returns the 32-byte shared secret. */
export function x25519DH(privateKeyBase64: string, publicKeyBase64: string): Uint8Array {
  return x25519.getSharedSecret(fromBase64(privateKeyBase64), fromBase64(publicKeyBase64));
}

// Keep legacy aliases so callers that haven't migrated yet compile without changes.
/** @deprecated Use generateX25519KeyPair() */
export const generateECDHKeyPair = generateX25519KeyPair;
/** @deprecated Use x25519DH() directly */
export async function ecdhDeriveBits(priv: string, pub: string): Promise<Uint8Array> {
  return x25519DH(priv, pub);
}

// ─── Hashing & KDF ───────────────────────────────────────────────────────────

/** SHA-256 hash of arbitrary bytes. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', ab(data)));
}

/** First 8 bytes of SHA-256(publicKeyBase64), formatted as colon-separated hex pairs. */
export async function computeFingerprint(publicKeyBase64: string): Promise<string> {
  const hash = await sha256(fromBase64(publicKeyBase64));
  return Array.from(hash.slice(0, 8))
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':');
}

/** HKDF-SHA256: derive `outputLength` bytes from input key material. */
export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, outputLength: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ab(ikm), 'HKDF', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: ab(salt), info: ab(new TextEncoder().encode(info)) },
    key, outputLength * 8
  );
  return new Uint8Array(derived);
}

/** HMAC-SHA256. */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const ck = await crypto.subtle.importKey('raw', ab(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', ck, ab(data)));
}
