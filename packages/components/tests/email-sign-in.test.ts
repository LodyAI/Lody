import { describe, expect, it } from 'vitest';
import { buildEmailSignInInput } from '../src/lib/email-sign-in';

describe('buildEmailSignInInput', () => {
  it('omits callbackURL for native email sign-in to avoid the OAuth proxy', () => {
    expect(
      buildEmailSignInInput({
        email: 'user@example.com',
        password: 'password-123',
        callbackURL: 'https://lody.ai/login?view=email',
        isNativeApp: true,
      })
    ).toEqual({
      email: 'user@example.com',
      password: 'password-123',
      rememberMe: true,
    });
  });
});
