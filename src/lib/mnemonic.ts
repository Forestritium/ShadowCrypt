/**
 * BIP-39 mnemonic utilities for ShadowCrypt recovery phrases.
 * Uses @scure/bip39 for standards-compliant 12-word generation.
 *
 * Hash algorithm: PBKDF2-SHA256, 100 000 iterations, 32-byte output, random 16-byte per-user salt.
 * This replaces the previous unsalted SHA-256 (v0) which was vulnerable to precomputation attacks.
 */

import { generateMnemonic as scureGenerate, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { toBase64, fromBase64, ab } from '@/lib/crypto';

export { validateMnemonic };

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_BYTES  = 32;

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

/**
 * Derive a salted PBKDF2-SHA256 hash of a mnemonic phrase.
 *
 * @param mnemonic    - raw phrase (normalized internally)
 * @param saltBase64  - base64-encoded 16-byte random per-user salt
 * @returns hex-encoded 32-byte PBKDF2 output
 */
export async function hashMnemonic(mnemonic: string, saltBase64: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    ab(new TextEncoder().encode(normalizeMnemonic(mnemonic))),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: ab(fromBase64(saltBase64)), iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    PBKDF2_KEY_BYTES * 8
  );
  return Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a fresh random salt and compute the PBKDF2 mnemonic hash in one step.
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
