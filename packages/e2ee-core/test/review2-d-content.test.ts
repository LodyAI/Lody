/**
 * Round-2 review D: Flock provider binding, cross-model/kind substitution, epoch binding
 * and exhaustive single-bit tamper of real sealed frames. Real crypto, no stubs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { PayloadProtectionContext } from '@loro-dev/streams-crdt/loro';
import { ContentCipher, inspectContent } from '../src/content';
import { toHex } from '../src/wire';
import { createStreamsContentProvider } from '../src/streams-content';

let pair: CryptoKeyPair;
let publicKey: string;
const K0 = new Uint8Array(32).fill(1);
const K1 = new Uint8Array(32).fill(2);
const update: PayloadProtectionContext = {
  protocol: 'loro-streams-crdt-payload-protection',
  version: 2,
  kind: 'update_batch',
};
const snapshot = (offset: string) =>
  ({ ...update, kind: 'snapshot', continuationOffset: offset }) as PayloadProtectionContext;

beforeAll(async () => {
  pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  publicKey = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
});

function provider(input: {
  model: 'loro' | 'flock';
  resource?: string;
  writeEpoch?: number;
  keys?: Record<number, Uint8Array>;
}) {
  const keys = input.keys ?? { 0: K0, 1: K1 };
  return createStreamsContentProvider({
    cipher: new ContentCipher({
      authorize(header) {
        if (header.actor !== 'A' || header.memberInstance !== 'A1' || header.device !== 'D')
          throw new Error('unauthorized');
        return publicKey;
      },
    }),
    genesis: 'ab'.repeat(32),
    resource: input.resource ?? 'doc-1',
    model: input.model,
    writeEpoch: input.writeEpoch ?? 0,
    author: { actor: 'A', memberInstance: 'A1', device: 'D' },
    signingKey: pair.privateKey,
    readKey: (epoch) => keys[epoch],
    mayWriteDocument: () => true,
  });
}

const binding = new Uint8Array([7, 7, 7]);
const plaintext = new TextEncoder().encode('flock-secret');

describe('R2-D Flock provider binding', () => {
  it('SAFE: Loro and Flock frames are not interchangeable in either direction or kind', async () => {
    const loro = provider({ model: 'loro' });
    const flock = provider({ model: 'flock' });
    for (const [writer, reader] of [
      [loro, flock],
      [flock, loro],
    ] as const) {
      const u = await writer.seal({ plaintext, context: update, additionalData: () => binding });
      await expect(reader.open({ ...u, context: update, additionalData: binding })).rejects.toThrow(
        'content-context-mismatch'
      );
      const s = await writer.seal({
        plaintext,
        context: snapshot('00000000000000000042'),
        additionalData: () => binding,
      });
      await expect(
        reader.open({ ...s, context: snapshot('00000000000000000042'), additionalData: binding })
      ).rejects.toThrow('content-context-mismatch');
    }
  });

  it('SAFE: a Flock update relabelled as a snapshot (or the reverse) is refused', async () => {
    const flock = provider({ model: 'flock' });
    const u = await flock.seal({ plaintext, context: update, additionalData: () => binding });
    expect(inspectContent(u.sealed).purpose).toBe('flock-update');
    // Relabel the one-byte provider header too, so only the content purpose can catch it.
    await expect(
      flock.open({
        header: new Uint8Array([2]),
        sealed: u.sealed,
        context: snapshot('00000000000000000001'),
        additionalData: binding,
      })
    ).rejects.toThrow('content-context-mismatch');
    const s = await flock.seal({
      plaintext,
      context: snapshot('00000000000000000001'),
      additionalData: () => binding,
    });
    await expect(
      flock.open({
        header: new Uint8Array([1]),
        sealed: s.sealed,
        context: update,
        additionalData: binding,
      })
    ).rejects.toThrow('content-context-mismatch');
  });

  it('SAFE: Flock cross-resource substitution and wrong-epoch key are refused', async () => {
    const writer = provider({ model: 'flock', writeEpoch: 1 });
    const u = await writer.seal({ plaintext, context: update, additionalData: () => binding });
    expect(inspectContent(u.sealed).epoch).toBe(1);
    await expect(
      provider({ model: 'flock', resource: 'doc-2' }).open({
        ...u,
        context: update,
        additionalData: binding,
      })
    ).rejects.toThrow('content-context-mismatch');
    // Reader whose slot 1 holds K_0 (e.g. mis-installed): HKDF binds epoch, AEAD fails.
    await expect(
      provider({ model: 'flock', keys: { 1: K0 } }).open({
        ...u,
        context: update,
        additionalData: binding,
      })
    ).rejects.toThrow();
    await expect(
      provider({ model: 'flock', keys: { 0: K0 } }).open({
        ...u,
        context: update,
        additionalData: binding,
      })
    ).rejects.toThrow('missing-content-key');
    const ok = await provider({ model: 'flock' }).open({
      ...u,
      context: update,
      additionalData: binding,
    });
    expect(new TextDecoder().decode(ok)).toBe('flock-secret');
  });

  it('SAFE: every single-bit flip, truncation or extension of a sealed Flock snapshot fails', async () => {
    const flock = provider({ model: 'flock' });
    const ctx = snapshot('00000000000000000009');
    const s = await flock.seal({ plaintext, context: ctx, additionalData: () => binding });
    const accepted: string[] = [];
    for (let i = 0; i < s.sealed.byteLength; i++) {
      for (const bit of [0x01, 0x80]) {
        const mutated = s.sealed.slice();
        mutated[i]! ^= bit;
        const ok = await Promise.resolve()
          .then(() =>
            flock.open({ header: s.header, sealed: mutated, context: ctx, additionalData: binding })
          )
          .then(
            () => true,
            () => false
          );
        if (ok) accepted.push(`${i}^${bit}`);
      }
    }
    for (const mutated of [
      s.sealed.subarray(0, s.sealed.byteLength - 1),
      new Uint8Array([...s.sealed, 0]),
    ]) {
      await expect(
        flock.open({ header: s.header, sealed: mutated, context: ctx, additionalData: binding })
      ).rejects.toThrow();
    }
    expect(accepted).toEqual([]);
  });
});
