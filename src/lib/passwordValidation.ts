/**
 * Password validation rules shared between AuthPage (registration, migration,
 * forgot-password reset) and the test suite.
 *
 * Rules (must ALL pass):
 *   - At least 12 characters
 *   - at least 1 uppercase letter
 *   - at least 1 lowercase letter
 *   - at least 1 digit
 *   - at least 1 special character (non-alphanumeric)
 */

export interface PasswordRequirement {
  label: string;
  met: (p: string) => boolean;
}

export const PASSWORD_REQUIREMENTS: PasswordRequirement[] = [
  { label: 'At least 12 characters', met: p => p.length >= 12 },
  { label: '1 uppercase letter', met: p => /[A-Z]/.test(p) },
  { label: '1 lowercase letter', met: p => /[a-z]/.test(p) },
  { label: '1 number',           met: p => /[0-9]/.test(p) },
  { label: '1 special character',met: p => /[^a-zA-Z0-9]/.test(p) },
];

/** Returns null when the password is valid, or a human-readable error string. */
export function validatePassword(p: string): string | null {
  if (p.length < 12) return 'Password must be at least 12 characters.';
  if (!/[A-Z]/.test(p))              return 'Must include at least 1 uppercase letter.';
  if (!/[a-z]/.test(p))              return 'Must include at least 1 lowercase letter.';
  if (!/[0-9]/.test(p))              return 'Must include at least 1 number.';
  if (!/[^a-zA-Z0-9]/.test(p))      return 'Must include at least 1 special character.';
  return null;
}
