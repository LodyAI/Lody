import { describe, expect, it } from 'vitest';

import { PASSWORD_MIN_LENGTH, validateNewPassword } from '../src/lib/password-validation';

describe('validateNewPassword', () => {
  it('rejects passwords shorter than the minimum length', () => {
    const result = validateNewPassword('aB1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('too-short');
      expect(result.minLength).toBe(PASSWORD_MIN_LENGTH);
    }
  });

  it('rejects passwords without any digit', () => {
    const result = validateNewPassword('abcdefgh');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('needs-letter-and-digit');
    }
  });

  it('rejects passwords without any letter', () => {
    const result = validateNewPassword('12345678');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('needs-letter-and-digit');
    }
  });

  it('accepts passwords meeting the length and complexity rules', () => {
    expect(validateNewPassword('abcd1234').ok).toBe(true);
    expect(validateNewPassword('Hello12345').ok).toBe(true);
    expect(validateNewPassword('p@ssw0rd').ok).toBe(true);
  });
});
