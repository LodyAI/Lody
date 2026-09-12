import { describe, expect, it } from 'vitest';
import {
  createSessionShareSecret,
  createSessionShareUrl,
  hashSessionShareSecret,
  parseSessionShareFragment,
} from '../src/session-sharing';

describe('session share credentials', () => {
  it('keeps the bearer secret entirely in the fragment', () => {
    const secret = createSessionShareSecret();
    const url = new URL(createSessionShareUrl('share_1', secret, 'https://share.example.test/'));
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(url.origin + url.pathname + url.search).toBe('https://share.example.test/s/share_1');
    expect(parseSessionShareFragment(url.hash)).toBe(secret);
  });

  it('rejects incomplete, ambiguous, and future credentials instead of guessing', () => {
    const secret = 'a'.repeat(64);
    for (const fragment of [
      '',
      `?access=v1.${secret}`,
      `#access=v2.${secret}`,
      `#access=v1.${secret}&key=other`,
      `#access=v1.${secret}&access=v1.${secret}`,
      `#access=v1.${secret.toUpperCase()}`,
    ])
      expect(parseSessionShareFragment(fragment)).toBeNull();
    expect(() =>
      createSessionShareUrl('../workspace', secret, 'https://share.example.test')
    ).toThrow('Invalid share link');
  });

  it('produces a stable domain-separated digest without retaining the secret', async () => {
    const secret = 'a'.repeat(64);
    const digest = await hashSessionShareSecret(secret);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toBe(secret);
    expect(await hashSessionShareSecret(secret)).toBe(digest);
    expect(await hashSessionShareSecret('b'.repeat(64))).not.toBe(digest);
    await expect(hashSessionShareSecret('weak-secret')).rejects.toThrow('Invalid share credential');
  });
});

describe('session share origin injection', () => {
  it('normalizes the injected origin, preserving the fragment and local test ports', () => {
    const secret = 'a'.repeat(64);
    for (const origin of [
      'https://staging.example.test/',
      'http://localhost:5179/',
      'http://[::1]:5179/',
    ]) {
      const link = new URL(createSessionShareUrl('share', secret, origin));
      expect(link.origin).toBe(new URL(origin).origin);
      expect(link.pathname).toBe('/s/share');
      expect(link.search).toBe('');
      expect(parseSessionShareFragment(link.hash)).toBe(secret);
    }
  });
  it.each([
    '',
    'http://share.example.test',
    'javascript:alert(1)',
    'https://user:pass@share.example.test',
    'https://share.example.test/path',
    'https://share.example.test?redirect=elsewhere',
    'https://share.example.test#access=old',
  ])('rejects invalid origin %s', (origin) => {
    expect(() => createSessionShareUrl('share', 'a'.repeat(64), origin)).toThrow();
  });
});
