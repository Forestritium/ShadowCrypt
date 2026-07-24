import { describe, it, expect } from 'vitest';
import { buildQRValue, parseQRValue } from '../QRContactDialog';

describe('QRContactDialog', () => {
  it('builds a deep-link URL with encoded query params', () => {
    const url = buildQRValue('alice', 'tok+en', 'fp#1');
    expect(url).toContain('/add-contact?');
    expect(url).toContain('u=alice');
    expect(url).toContain('t=tok%2Ben');
    expect(url).toContain('fp=fp%231');
  });

  it('parses the new URL format', () => {
    const url = buildQRValue('bob', 'token123', 'fingerprint-abc');
    const parsed = parseQRValue(url);
    expect(parsed).toEqual({
      username: 'bob',
      token: 'token123',
      fingerprint: 'fingerprint-abc',
    });
  });

  it('parses the legacy sylvacrypt:add: format', () => {
    const parsed = parseQRValue('sylvacrypt:add:charlie/legacy-token/legacy-fp');
    expect(parsed).toEqual({
      username: 'charlie',
      token: 'legacy-token',
      fingerprint: 'legacy-fp',
    });
  });

  it('returns null or partial results for malformed values', () => {
    expect(parseQRValue('')).toBeNull();
    expect(parseQRValue('https://example.com')).toBeNull();
    const partial = parseQRValue('sylvacrypt:add:missing-parts');
    expect(partial?.username).toBe('missing-parts');
    expect(partial?.token).toBeNull();
  });
});
