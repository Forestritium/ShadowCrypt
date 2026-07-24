/**
 * Tests for BIP-39 mnemonic utilities (src/lib/mnemonic.ts).
 *
 * Covers:
 *   - generateMnemonic: produces a valid 12-word BIP-39 phrase
 *   - normalizeMnemonic: trims, lowercases, collapses whitespace
 *   - isValidMnemonic: accepts valid phrases, rejects invalid ones
 *   - hashMnemonic / generateMnemonicHash: deterministic PBKDF2 output,
 *     different salts produce different hashes, normalization is applied
 */

import { describe, it, expect } from 'vitest';
import {
  generateMnemonic,
  normalizeMnemonic,
  isValidMnemonic,
  hashMnemonic,
  generateMnemonicHash,
} from '../mnemonic';
import { toBase64 } from '../crypto';

// ─── generateMnemonic ────────────────────────────────────────────────────────

describe('generateMnemonic', () => {
  it('returns a string of exactly 12 space-separated words', () => {
    const m = generateMnemonic();
    expect(typeof m).toBe('string');
    expect(m.trim().split(' ')).toHaveLength(12);
  });

  it('produces a valid BIP-39 phrase', () => {
    expect(isValidMnemonic(generateMnemonic())).toBe(true);
  });

  it('generates unique phrases on each call', () => {
    const a = generateMnemonic();
    const b = generateMnemonic();
    expect(a).not.toBe(b);
  });
});

// ─── normalizeMnemonic ───────────────────────────────────────────────────────

describe('normalizeMnemonic', () => {
  it('trims leading/trailing whitespace', () => {
    expect(normalizeMnemonic('  zoo zoo zoo  ')).toBe('zoo zoo zoo');
  });

  it('lowercases the phrase', () => {
    expect(normalizeMnemonic('ABANDON ABANDON ABANDON')).toBe(
      'abandon abandon abandon'
    );
  });

  it('collapses multiple spaces into a single space', () => {
    expect(normalizeMnemonic('one  two   three')).toBe('one two three');
  });

  it('handles tabs and newlines as whitespace', () => {
    expect(normalizeMnemonic('one\ttwo\nthree')).toBe('one two three');
  });
});

// ─── isValidMnemonic ─────────────────────────────────────────────────────────

describe('isValidMnemonic', () => {
  it('accepts a freshly generated phrase', () => {
    expect(isValidMnemonic(generateMnemonic())).toBe(true);
  });

  it('accepts a known-valid 12-word BIP-39 phrase', () => {
    // "abandon" repeated 11 times + "about" is a checksum-valid phrase
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    expect(isValidMnemonic(phrase)).toBe(true);
  });

  it('rejects a phrase with a non-BIP-39 word', () => {
    expect(isValidMnemonic('notaword abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidMnemonic('')).toBe(false);
  });

  it('rejects a phrase with fewer than 12 words', () => {
    expect(isValidMnemonic('abandon abandon abandon')).toBe(false);
  });

  it('rejects a phrase with more than 12 words', () => {
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about extra';
    expect(isValidMnemonic(phrase)).toBe(false);
  });

  it('accepts a phrase with extra whitespace (normalizes internally)', () => {
    const phrase = '  abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about  ';
    expect(isValidMnemonic(phrase)).toBe(true);
  });

  it('accepts a phrase with uppercase letters (normalizes internally)', () => {
    const phrase = 'ABANDON abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    expect(isValidMnemonic(phrase)).toBe(true);
  });
});

// ─── hashMnemonic ────────────────────────────────────────────────────────────

describe('hashMnemonic', () => {
  const fixedSalt = toBase64(new Uint8Array(16).fill(1)); // deterministic test salt

  it('returns a prefixed 64-character hex string (32 bytes)', async () => {
    const hash = await hashMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', fixedSalt);
    expect(hash).toMatch(/^\$argon2id\$v2\$[0-9a-f]{64}$/);
  });

  it('is deterministic: same inputs produce the same hash', async () => {
    const phrase = generateMnemonic();
    const h1 = await hashMnemonic(phrase, fixedSalt);
    const h2 = await hashMnemonic(phrase, fixedSalt);
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different salts', async () => {
    const phrase = generateMnemonic();
    const salt2 = toBase64(new Uint8Array(16).fill(2));
    const h1 = await hashMnemonic(phrase, fixedSalt);
    const h2 = await hashMnemonic(phrase, salt2);
    expect(h1).not.toBe(h2);
  });

  it('produces different hashes for different phrases (same salt)', async () => {
    const p1 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const p2 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
    // p2 may not be valid BIP-39 but hashMnemonic operates on raw strings
    const h1 = await hashMnemonic(p1, fixedSalt);
    const h2 = await hashMnemonic(p2, fixedSalt);
    expect(h1).not.toBe(h2);
  });

  it('normalizes the phrase before hashing (case + whitespace)', async () => {
    const lower = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const upper = 'ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABANDON ABOUT';
    const padded = '  abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about  ';
    const hLower  = await hashMnemonic(lower, fixedSalt);
    const hUpper  = await hashMnemonic(upper, fixedSalt);
    const hPadded = await hashMnemonic(padded, fixedSalt);
    expect(hUpper).toBe(hLower);
    expect(hPadded).toBe(hLower);
  });
});

// ─── generateMnemonicHash ────────────────────────────────────────────────────

describe('generateMnemonicHash', () => {
  it('returns a prefixed hash and a base64 salt', async () => {
    const phrase = generateMnemonic();
    const { hash, saltBase64 } = await generateMnemonicHash(phrase);
    expect(hash).toMatch(/^\$argon2id\$v2\$[0-9a-f]{64}$/);
    // base64 of 16 bytes is 24 chars (with padding)
    expect(saltBase64).toHaveLength(24);
  });

  it('generates a unique salt on each call', async () => {
    const phrase = generateMnemonic();
    const r1 = await generateMnemonicHash(phrase);
    const r2 = await generateMnemonicHash(phrase);
    expect(r1.saltBase64).not.toBe(r2.saltBase64);
  });

  it('hash is reproducible given the returned salt', async () => {
    const phrase = generateMnemonic();
    const { hash, saltBase64 } = await generateMnemonicHash(phrase);
    const recomputed = await hashMnemonic(phrase, saltBase64);
    expect(recomputed).toBe(hash);
  });

  it('different salts yield different hashes for the same phrase', async () => {
    const phrase = generateMnemonic();
    const r1 = await generateMnemonicHash(phrase);
    const r2 = await generateMnemonicHash(phrase);
    // Salts differ → hashes must differ
    expect(r1.hash).not.toBe(r2.hash);
  });
});
