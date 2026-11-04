import { describe, expect, it } from 'vitest';
import {
  createSessionShareSecret,
  createSessionShareUrl,
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
});
