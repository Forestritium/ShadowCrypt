/**
 * Tests for password validation (src/lib/passwordValidation.ts).
 *
 * Covers:
 *   - validatePassword: every individual rule, all-passing case
 *   - PASSWORD_REQUIREMENTS: each requirement's `met` predicate
 */

import { describe, it, expect } from 'vitest';
import { validatePassword, PASSWORD_REQUIREMENTS } from '../passwordValidation';

// ─── validatePassword ────────────────────────────────────────────────────────

describe('validatePassword', () => {
  it('returns null for a fully valid password', () => {
    expect(validatePassword('HelloWorld1!')).toBeNull();
    expect(validatePassword('Abcdefghij1!')).toBeNull();
    expect(validatePassword('Str0ng!Password')).toBeNull();
  });

  // Length
  it('rejects passwords shorter than 12 characters', () => {
    expect(validatePassword('A1!bc')).toMatch(/12/); // 5 chars
    expect(validatePassword('')).toMatch(/12/);
  });

  it('accepts passwords at exactly 12 characters', () => {
    expect(validatePassword('Aa1!xyabcdef')).toBeNull();
  });

  // Uppercase
  it('rejects passwords with no uppercase letter', () => {
    expect(validatePassword('hellohello1!')).toMatch(/uppercase/i);
  });

  // Lowercase
  it('rejects passwords with no lowercase letter', () => {
    expect(validatePassword('HELLOHELLO1!')).toMatch(/lowercase/i);
  });

  // Digit
  it('rejects passwords with no digit', () => {
    expect(validatePassword('HelloHello!!')).toMatch(/number/i);
  });

  // Special character
  it('rejects passwords with no special character', () => {
    expect(validatePassword('HelloHello123')).toMatch(/special/i);
  });

  // Edge cases
  it('rejects a password that meets length but fails all other rules', () => {
    expect(validatePassword('abcdefghijkl')).not.toBeNull();
  });

  it('returns the first failing rule message (length checked first)', () => {
    // Too short AND no uppercase — length error comes first
    expect(validatePassword('a1!')).toMatch(/12/);
  });
});

// ─── PASSWORD_REQUIREMENTS predicates ────────────────────────────────────────

describe('PASSWORD_REQUIREMENTS', () => {
  const req = (label: string) => {
    const r = PASSWORD_REQUIREMENTS.find(r => r.label === label);
    if (!r) throw new Error(`Requirement "${label}" not found`);
    return r.met;
  };

  it('At least 12 characters: true if >= 12, false otherwise', () => {
    const met = req('At least 12 characters');
    expect(met('abcde123456')).toBe(false);   // 11
    expect(met('abcdef123456')).toBe(true);   // 12
    expect(met('a'.repeat(128))).toBe(true);
  });

  it('1 uppercase letter', () => {
    const met = req('1 uppercase letter');
    expect(met('hello')).toBe(false);
    expect(met('Hello')).toBe(true);
    expect(met('HELLO')).toBe(true);
  });

  it('1 lowercase letter', () => {
    const met = req('1 lowercase letter');
    expect(met('HELLO')).toBe(false);
    expect(met('HELLo')).toBe(true);
  });

  it('1 number', () => {
    const met = req('1 number');
    expect(met('Abcdef')).toBe(false);
    expect(met('Abcde1')).toBe(true);
  });

  it('1 special character', () => {
    const met = req('1 special character');
    expect(met('Abcde1')).toBe(false);
    expect(met('Abcde1!')).toBe(true);
    expect(met('Abcde1@')).toBe(true);
    expect(met('Abcde1 ')).toBe(true); // space is non-alphanumeric
  });

  it('has exactly 5 requirements', () => {
    expect(PASSWORD_REQUIREMENTS).toHaveLength(5);
  });
});
