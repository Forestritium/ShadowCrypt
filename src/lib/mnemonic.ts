/**
 * BIP-39 mnemonic utilities for SylvaCrypt recovery phrases.
 * Uses @scure/bip39 for standards-compliant 12-word generation.
 *
 * Hash algorithm history:
 *   v0 (legacy): PBKDF2-SHA256, 100 000 iterations, 32-byte output, random 16-byte per-user salt.
 *   v1 (current): Argon2id (memory-hard), 32-byte output, random 16-byte per-user salt.
 *
 * New recovery phrases always use Argon2id. The legacy PBKDF2 verifier is kept
 * for transparent migration of existing hashes during the next unlock.
 */

import { generateMnemonic as scureGenerate, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { argon2id } from 'hash-wasm';
import { toBase64, fromBase64, ab } from '@/lib/crypto';

export { validateMnemonic };

const LEGACY_PBKDF2_ITERATIONS = 100_000;
const HASH_KEY_BYTES = 32;

/** Generate a fresh 12-word BIP-39 mnemonic (128-bit entropy). */
export function generateMnemonic(): string {
  return scureGenerate(wordlist, 128);
}

/** Normalize user-typed mnemonic: trim, lowercase, collapse whitespace. */
export function normalizeMnemonic(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Validate that a string is a valid 12-word BIP-39 phrase. */
export function isValidMnemonic(phrase: string): boolean {
  return validateMnemonic(normalizeMnemonic(phrase), wordlist);
}

export const ARGON2ID_HASH_PREFIX = '$argon2id$v2$';

/** Argon2id hash of a normalized mnemonic phrase (current v2 algorithm). */
export async function hashMnemonic(mnemonic: string, saltBase64: string): Promise<string> {
  const raw = (await argon2id({
    password: normalizeMnemonic(mnemonic),
    salt: fromBase64(saltBase64),
    parallelism: 4,
    iterations: 4,
    memorySize: 262144,
    hashLength: HASH_KEY_BYTES,
    outputType: 'binary',
  })) as Uint8Array;
  const hex = Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join('');
  return ARGON2ID_HASH_PREFIX + hex;
}

/** Strip the Argon2id prefix from a stored hash, if present. */
export function stripMnemonicHashPrefix(storedHash: string): { hash: string; isLegacy: boolean; isV1: boolean } {
  if (storedHash.startsWith(ARGON2ID_HASH_PREFIX)) {
    return { hash: storedHash.slice(ARGON2ID_HASH_PREFIX.length), isLegacy: false, isV1: false };
  } else if (storedHash.startsWith('$argon2id$')) {
    return { hash: storedHash.slice(10), isLegacy: false, isV1: true };
  }
  return { hash: storedHash, isLegacy: true, isV1: false };
}

/**
 * Legacy PBKDF2-SHA256 hash of a mnemonic phrase.
 * Kept only for transparent migration of existing v0 hashes.
 */
export async function hashMnemonicLegacyPBKDF2(mnemonic: string, saltBase64: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    ab(new TextEncoder().encode(normalizeMnemonic(mnemonic))),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: ab(fromBase64(saltBase64)), iterations: LEGACY_PBKDF2_ITERATIONS },
    keyMaterial,
    HASH_KEY_BYTES * 8
  );
  return Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a mnemonic against a stored hash. Supports both legacy PBKDF2 and
 * current Argon2id hashes (auto-detected by the stored prefix).
 */
export async function verifyMnemonicHash(
  mnemonic: string,
  saltBase64: string,
  storedHash: string
): Promise<boolean> {
  const { isLegacy, isV1 } = stripMnemonicHashPrefix(storedHash);
  
  let computed: string;
  if (isLegacy) {
    computed = await hashMnemonicLegacyPBKDF2(mnemonic, saltBase64);
  } else if (isV1) {
    computed = ('$argon2id$' + Array.from((await argon2id({
        password: normalizeMnemonic(mnemonic),
        salt: fromBase64(saltBase64),
        parallelism: 1,
        iterations: 3,
        memorySize: 65536,
        hashLength: HASH_KEY_BYTES,
        outputType: 'binary',
      }) as Uint8Array)).map(b => b.toString(16).padStart(2, '0')).join(''));
  } else {
    computed = (ARGON2ID_HASH_PREFIX + Array.from((await argon2id({
        password: normalizeMnemonic(mnemonic),
        salt: fromBase64(saltBase64),
        parallelism: 4,
        iterations: 4,
        memorySize: 262144,
        hashLength: HASH_KEY_BYTES,
        outputType: 'binary',
      }) as Uint8Array)).map(b => b.toString(16).padStart(2, '0')).join(''));
  }

  const a = computed.toLowerCase();
  const b = storedHash.toLowerCase();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Transparently migrate a legacy PBKDF2 mnemonic hash to Argon2id.
 * Returns the new Argon2id hash if the mnemonic matches the legacy hash,
 * otherwise null.
 */
export async function migrateMnemonicHashIfNeeded(
  mnemonic: string,
  saltBase64: string,
  storedHash: string
): Promise<string | null> {
  const { isLegacy } = stripMnemonicHashPrefix(storedHash);
  if (!isLegacy) return storedHash;
  const legacyMatch = await hashMnemonicLegacyPBKDF2(mnemonic, saltBase64);
  const a = legacyMatch.toLowerCase();
  const b = storedHash.toLowerCase();
  let diff = 0;
  if (a.length !== b.length) {
    diff = 1;
  } else {
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
  }
  if (diff !== 0) return null;
  return hashMnemonic(mnemonic, saltBase64);
}

/**
 * Generate a fresh random salt and compute the Argon2id mnemonic hash in one step.
 * Use this when storing a new or regenerated recovery phrase.
 *
 * @returns { hash, saltBase64 } — both must be persisted to profiles.mnemonic_hash / mnemonic_salt
 */
export async function generateMnemonicHash(
  mnemonic: string
): Promise<{ hash: string; saltBase64: string }> {
  const saltBase64 = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await hashMnemonic(mnemonic, saltBase64);
  return { hash, saltBase64 };
}
