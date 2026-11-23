import { describe, expect, it } from 'vitest';

import { isSafeAuthRedirect } from '../src/lib/auth-redirect';

const APP_ORIGIN = 'https://lody.ai';

describe('isSafeAuthRedirect', () => {
  it('allows same-origin absolute URLs', () => {
    expect(isSafeAuthRedirect('https://lody.ai/dashboard', { appOrigin: APP_ORIGIN })).toBe(
      'https://lody.ai/dashboard'
    );
  });

  it('allows same-origin relative paths', () => {
    expect(isSafeAuthRedirect('/dashboard', { appOrigin: APP_ORIGIN })).toBe('/dashboard');
  });

  it('rejects forbidden same-pathname to prevent loops', () => {
    expect(
      isSafeAuthRedirect('/login', { appOrigin: APP_ORIGIN, forbiddenSamePathname: '/login' })
    ).toBeNull();
    expect(
      isSafeAuthRedirect('https://lody.ai/login', {
        appOrigin: APP_ORIGIN,
        forbiddenSamePathname: '/login',
      })
    ).toBeNull();
  });

  it('allows lody.ai subdomains over https', () => {
    expect(isSafeAuthRedirect('https://feedback.lody.ai/post/abc', { appOrigin: APP_ORIGIN })).toBe(
      'https://feedback.lody.ai/post/abc'
    );
    expect(isSafeAuthRedirect('https://lody.ai/landing', { appOrigin: APP_ORIGIN })).toBe(
      'https://lody.ai/landing'
    );
  });

  it('rejects http lody.ai URLs', () => {
    expect(isSafeAuthRedirect('http://feedback.lody.ai', { appOrigin: APP_ORIGIN })).toBeNull();
  });

  it('rejects foreign domains', () => {
    expect(isSafeAuthRedirect('https://evil.com', { appOrigin: APP_ORIGIN })).toBeNull();
  });

  it('rejects suffix-tricks that embed lody.ai in another host', () => {
    expect(isSafeAuthRedirect('https://lody.ai.evil.com', { appOrigin: APP_ORIGIN })).toBeNull();
    expect(isSafeAuthRedirect('https://notlody.ai', { appOrigin: APP_ORIGIN })).toBeNull();
  });

  it('rejects protocol-relative URLs to a foreign host', () => {
    expect(isSafeAuthRedirect('//evil.com', { appOrigin: APP_ORIGIN })).toBeNull();
  });

  it('rejects javascript: and data: schemes', () => {
    expect(isSafeAuthRedirect('javascript:alert(1)', { appOrigin: APP_ORIGIN })).toBeNull();
    expect(
      isSafeAuthRedirect('data:text/html,<script>alert(1)</script>', { appOrigin: APP_ORIGIN })
    ).toBeNull();
  });

  it('allows a localhost dev origin when configured as the app origin', () => {
    expect(isSafeAuthRedirect('/dashboard', { appOrigin: 'http://localhost:5173' })).toBe(
      '/dashboard'
    );
    expect(
      isSafeAuthRedirect('http://localhost:5173/dashboard', {
        appOrigin: 'http://localhost:5173',
      })
    ).toBe('http://localhost:5173/dashboard');
  });
});
