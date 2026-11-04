import { describe, expect, it } from 'vitest';

import {
  buildEmailVerificationCallbackSearch,
  buildEmailVerificationCallbackUrl,
} from '../src/lib/email-verification-callback';

const baseInput = {
  targetEmail: 'user@example.com',
  appOrigin: 'https://app.lody.ai',
  loginPathname: '/login',
};

describe('buildEmailVerificationCallbackSearch', () => {
  it('keeps the email sign-in view and drops stale error state', () => {
    const params = buildEmailVerificationCallbackSearch({
      ...baseInput,
      sourceSearchParams: new URLSearchParams({
        view: 'oauth',
        email: 'old@example.com',
        error: 'TOKEN_EXPIRED',
      }),
    });

    expect(params.get('view')).toBe('email');
    expect(params.get('email')).toBe('user@example.com');
    expect(params.has('error')).toBe(false);
  });

  it('preserves a safe redirect for invite and protected-workspace flows', () => {
    const params = buildEmailVerificationCallbackSearch({
      ...baseInput,
      sourceSearchParams: new URLSearchParams({
        redirect: '/invite/abc?workspace=lody',
      }),
    });

    expect(params.get('redirect')).toBe('/invite/abc?workspace=lody');
  });

  it('drops unsafe redirects from verification callbacks', () => {
    const params = buildEmailVerificationCallbackSearch({
      ...baseInput,
      sourceSearchParams: new URLSearchParams({
        redirect: 'https://evil.example/login',
      }),
    });

    expect(params.has('redirect')).toBe(false);
  });

  it('preserves Electron OAuth state through verification callbacks', () => {
    const params = buildEmailVerificationCallbackSearch({
      ...baseInput,
      sourceSearchParams: new URLSearchParams(),
      electronOAuthQuery: {
        client_id: 'electron',
        state: 'state-1',
        code_challenge: 'challenge-1',
        code_challenge_method: 'S256',
      },
    });

    expect(params.get('client_id')).toBe('electron');
    expect(params.get('state')).toBe('state-1');
    expect(params.get('code_challenge')).toBe('challenge-1');
    expect(params.get('code_challenge_method')).toBe('S256');
  });

  it('normalizes the mobile ./ login path before building callback URLs', () => {
    const url = buildEmailVerificationCallbackUrl({
      ...baseInput,
      callbackBaseUrl: 'https://lody.ai',
      loginPathname: './login',
      sourceSearchParams: new URLSearchParams(),
    });

    expect(url).toBe('https://lody.ai/login?view=email&email=user%40example.com');
  });

  it('keeps a configured public app base path without duplicating it', () => {
    const url = buildEmailVerificationCallbackUrl({
      ...baseInput,
      callbackBaseUrl: 'https://lody.ai/app',
      loginPathname: '/app/login',
      sourceSearchParams: new URLSearchParams(),
    });

    expect(url).toBe('https://lody.ai/app/login?view=email&email=user%40example.com');
  });

  it('still forbids redirecting back to the login page when callbackPathname differs', () => {
    const params = buildEmailVerificationCallbackSearch({
      ...baseInput,
      sourceSearchParams: new URLSearchParams({ redirect: '/login' }),
    });

    expect(params.has('redirect')).toBe(false);
  });
});
