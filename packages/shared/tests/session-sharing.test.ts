import { describe, expect, it } from 'vitest';
import {
  createSessionShareSecret,
  createSessionShareUrl,
  hashSessionShareSecret,
  parseSessionShareFragment,
  createShareDeliveryKey,
  encryptShareDelivery,
  decryptShareDelivery,
  captureShareHistory,
} from '../src/session-sharing';

describe('session share credentials', () => {
  it('delivers only to the original recipient and binds request and origin', async () => {
    const key = await createShareDeliveryKey();
    const other = await createShareDeliveryKey();
    const secret = createSessionShareSecret();
    const envelope = await encryptShareDelivery(
      key.publicKey,
      'request',
      'https://share.test',
      secret
    );
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(await decryptShareDelivery(key.privateKey, 'request', envelope)).toBe(secret);
    await expect(decryptShareDelivery(other.privateKey, 'request', envelope)).rejects.toThrow();
    await expect(decryptShareDelivery(key.privateKey, 'other', envelope)).rejects.toThrow();
    await expect(
      decryptShareDelivery(key.privateKey, 'request', { ...envelope, origin: 'https://evil.test' })
    ).rejects.toThrow();
  });
  it('omits known share credentials from later exports without changing stored history', () => {
    const url = createSessionShareUrl('share', 'a'.repeat(64), 'https://share.test');
    const history = [
      {
        id: 'turn',
        role: 'assistant',
        items: [
          { type: 'text', text: url },
          { type: 'tool_call', output: { url } },
        ],
      },
    ];
    const captured = captureShareHistory(history);
    expect(JSON.stringify(captured)).not.toContain('a'.repeat(64));
    expect(JSON.stringify(captured)).toContain('/s/share#access=omitted');
    expect(history[0]?.items[0]?.text).toBe(url);
  });
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
