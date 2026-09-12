import { hkdfSync } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { LoroDoc } from 'loro-crdt';
import { Flock } from '@loro-dev/flock-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ContentCipher,
  inspectContent,
  MAX_CONTENT_BYTES,
  type ContentScope,
} from '../src/content';
import { fromHex, toHex } from '../src';
import { deferred } from './control-fixtures';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const epochKey = new Uint8Array(32).fill(7);
const scope: ContentScope = {
  genesis: '01'.repeat(32),
  epoch: 0,
  resource: 'doc-1',
  purpose: 'doc-update',
};
const author = { actor: 'A', memberInstance: 'A1', device: 'desktop' };
let alice: CryptoKeyPair;
let bob: CryptoKeyPair;
let alicePublic: string;
beforeAll(async () => {
  alice = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])) as CryptoKeyPair;
  bob = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])) as CryptoKeyPair;
  alicePublic = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', alice.publicKey)));
});
function cipher() {
  return new ContentCipher({
    authorize(header) {
      if (header.actor !== 'A' || header.memberInstance !== 'A1' || header.device !== 'desktop')
        throw new Error('unauthorized-author');
      return alicePublic;
    },
  });
}
function seal(plaintext: Uint8Array, context = scope) {
  return cipher().seal({
    scope: context,
    author,
    epochKey,
    signingKey: alice.privateKey,
    plaintext,
  });
}
function parts(wire: Uint8Array) {
  const length = new DataView(wire.buffer, wire.byteOffset, wire.byteLength).getUint16(0);
  return {
    length,
    header: wire.slice(2, 2 + length),
    nonce: wire.slice(2 + length, 26 + length),
    ciphertext: wire.slice(26 + length, -64),
  };
}

describe('signed content envelope', () => {
  it('matches the published XChaCha AEAD vector (not an IETF standard or protocol proof)', () => {
    // https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha-03#appendix-A.3.1
    const key = fromHex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
    const nonce = fromHex('404142434445464748494a4b4c4d4e4f5051525354555657');
    const aad = fromHex('50515253c0c1c2c3c4c5c6c7');
    const plaintext = fromHex(
      '4c616469657320616e642047656e746c656d656e206f662074686520636c617373206f66202739393a204966204920636f756c64206f6666657220796f75206f6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73637265656e20776f756c642062652069742e'
    );
    const expected = fromHex(
      'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780acf49'
    );
    expect(xchacha20poly1305(key, nonce, aad).encrypt(plaintext)).toEqual(expected);
    expect(xchacha20poly1305(key, nonce, aad).decrypt(expected)).toEqual(plaintext);
  });

  it('uses independently reproducible HKDF context and fresh nonce/message ID for each new encryption', async () => {
    const plaintext = encoder.encode('private content');
    const first = await seal(plaintext);
    const second = await seal(plaintext);
    const a = parts(first);
    const b = parts(second);
    expect(a.nonce).not.toEqual(b.nonce);
    const header = JSON.parse(decoder.decode(a.header)) as string[];
    expect(header.slice(0, 8)).toEqual([
      'lody-content/v1',
      scope.genesis,
      '0',
      'doc-1',
      'doc-update',
      'A',
      'A1',
      'desktop',
    ]);
    expect(header[8]).not.toBe((JSON.parse(decoder.decode(b.header)) as string[])[8]);
    const key = new Uint8Array(
      hkdfSync(
        'sha256',
        epochKey,
        encoder.encode('lody-content-hkdf/v1'),
        encoder.encode(
          JSON.stringify(['lody-content-key/v1', scope.genesis, '0', 'doc-1', 'doc-update'])
        ),
        32
      )
    );
    expect(xchacha20poly1305(key, a.nonce, a.header).decrypt(a.ciphertext)).toEqual(plaintext);
    expect((await cipher().open(scope, epochKey, first)).plaintext).toEqual(plaintext);
    await expect(cipher().open(scope, new Uint8Array(32).fill(8), first)).rejects.toThrow(
      'content-authentication-failed'
    );
  });

  it('binds Org, epoch, resource and purpose to the caller expectation and derived key', async () => {
    const wire = await seal(encoder.encode('secret'));
    const alternatives: ContentScope[] = [
      { ...scope, genesis: '02'.repeat(32) },
      { ...scope, epoch: 1 },
      { ...scope, resource: 'doc-2' },
      { ...scope, purpose: 'doc-snapshot' as const },
    ];
    for (const context of alternatives)
      await expect(cipher().open(context, epochKey, wire)).rejects.toThrow(
        'content-context-mismatch'
      );
    const { nonce, header, ciphertext } = parts(wire);
    for (const context of alternatives) {
      const key = new Uint8Array(
        hkdfSync(
          'sha256',
          epochKey,
          encoder.encode('lody-content-hkdf/v1'),
          encoder.encode(
            JSON.stringify([
              'lody-content-key/v1',
              context.genesis,
              String(context.epoch),
              context.resource,
              context.purpose,
            ])
          ),
          32
        )
      );
      expect(() => xchacha20poly1305(key, nonce, header).decrypt(ciphertext)).toThrow();
    }
  });

  it('authenticates the full header with AEAD even when a signer re-signs modified metadata', async () => {
    const wire = await seal(encoder.encode('secret'));
    const parsed = parts(wire);
    const header = JSON.parse(decoder.decode(parsed.header)) as string[];
    header[8] = 'ff'.repeat(16);
    const changed = wire.slice(0, -64);
    changed.set(encoder.encode(JSON.stringify(header)), 2);
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        'Ed25519',
        alice.privateKey,
        Buffer.concat([encoder.encode('lody-content-signature/v1\0'), changed])
      )
    );
    await expect(
      cipher().open(scope, epochKey, Buffer.concat([changed, signature]))
    ).rejects.toThrow('content-authentication-failed');
  });

  it('rejects unknown versions, extra fields, aliases and noncanonical headers before treating metadata as usable', async () => {
    const wire = await seal(encoder.encode('secret'));
    const parsed = parts(wire);
    const text = decoder.decode(parsed.header);
    for (const [header, error] of [
      ['private plaintext must not appear in parse errors', 'invalid-content-header'],
      [text.replace('lody-content/v1', 'lody-content/v9'), 'unsupported-content-version'],
      [' ' + text, 'noncanonical-content-header'],
      [text.replace('"0"', '"00"'), 'invalid-content-epoch'],
      [text.replace('"doc-1"', '"\\u0064oc-1"'), 'noncanonical-content-header'],
      [text.replace('"doc-update"', '"unknown"'), 'invalid-content-purpose'],
      [text.slice(0, -1) + ',"extra"]', 'invalid-content-header'],
    ]) {
      const bytes = encoder.encode(header!);
      const length = new Uint8Array(2);
      new DataView(length.buffer).setUint16(0, bytes.byteLength);
      const changed = Buffer.concat([length, bytes, wire.subarray(2 + parsed.length)]);
      expect(() => inspectContent(changed)).toThrow(error);
      await expect(cipher().open(scope, epochKey, changed)).rejects.toMatchObject({
        message: error,
      });
    }
    const untrusted = inspectContent(wire);
    expect(untrusted).toMatchObject({ ...scope, ...author });
    expect(Object.isFrozen(untrusted)).toBe(true);
    const rejecting = new ContentCipher({
      authorize: () => {
        throw new Error('not-admitted');
      },
    });
    await expect(rejecting.open(scope, epochKey, wire)).rejects.toThrow('not-admitted');
    const weak = new ContentCipher({ authorize: () => '01' + '00'.repeat(31) });
    await expect(weak.open(scope, epochKey, wire)).rejects.toThrow('invalid-signing-key');
  });

  it('rejects tampering in header, nonce, body, tag or signature without releasing plaintext', async () => {
    const wire = await seal(encoder.encode('secret'));
    const { length } = parts(wire);
    for (const position of [2, 2 + length, 26 + length, wire.length - 65, wire.length - 1]) {
      const changed = wire.slice();
      changed[position] = changed[position]! ^ 1;
      await expect(cipher().open(scope, epochKey, changed)).rejects.toThrow();
    }
    await expect(
      cipher().seal({
        scope,
        author,
        epochKey,
        signingKey: bob.privateKey,
        plaintext: encoder.encode('secret'),
      })
    ).rejects.toThrow('bad-content-signature');
    await expect(
      cipher().seal({
        scope,
        author: { ...author, actor: 'B' },
        epochKey,
        signingKey: alice.privateKey,
        plaintext: encoder.encode('secret'),
      })
    ).rejects.toThrow('unauthorized-author');
  });

  it('has no plaintext/unknown-version fallback and checks size before parsing', async () => {
    for (const wire of [
      new Uint8Array(),
      encoder.encode('{"plain":"secret"}'),
      new Uint8Array(100),
      new Uint8Array(MAX_CONTENT_BYTES + 5000),
    ])
      await expect(cipher().open(scope, epochKey, wire)).rejects.toThrow();
    const wire = await seal(new Uint8Array());
    expect((await cipher().open(scope, epochKey, wire)).plaintext).toEqual(new Uint8Array());
    for (const length of [1, wire.length - 1])
      await expect(cipher().open(scope, epochKey, wire.slice(0, length))).rejects.toThrow();
    await expect(seal(new Uint8Array(MAX_CONTENT_BYTES + 1))).rejects.toThrow('content-too-large');
    await expect(cipher().open(scope, new Uint8Array(31), wire)).rejects.toThrow(
      'invalid-content-key'
    );
  });

  it('accepts the exact payload limit including a nonzero input view offset', async () => {
    const data = new Uint8Array(MAX_CONTENT_BYTES + 1).fill(37).subarray(1);
    const wire = await seal(data);
    const plaintext = (await cipher().open(scope, epochKey, wire)).plaintext;
    expect(plaintext.byteLength).toBe(MAX_CONTENT_BYTES);
    expect(Buffer.compare(plaintext, data)).toBe(0);
  });

  it('copies mutable inputs before awaiting and rechecks authorization before releasing plaintext', async () => {
    const data = encoder.encode('original');
    const key = epochKey.slice();
    const context = { ...scope };
    const pending = cipher().seal({
      scope: context,
      author,
      epochKey: key,
      signingKey: alice.privateKey,
      plaintext: data,
    });
    data.fill(0);
    key.fill(0);
    context.resource = 'mutated';
    const wire = await pending;
    const input = wire.slice();
    const opening = cipher().open(scope, epochKey, input);
    input.fill(0);
    expect(decoder.decode((await opening).plaintext)).toBe('original');

    const entered = deferred();
    const release = deferred();
    let revoked = false;
    const platform = {
      getRandomValues: crypto.getRandomValues.bind(crypto),
      subtle: new Proxy(crypto.subtle, {
        get(target, prop) {
          if (prop === 'deriveBits')
            return async (...args: Parameters<SubtleCrypto['deriveBits']>) => {
              entered.resolve();
              await release.promise;
              return target.deriveBits(...args);
            };
          const value: unknown = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    };
    const guarded = new ContentCipher(
      {
        authorize() {
          if (revoked) throw new Error('revoked');
          return alicePublic;
        },
      },
      platform
    );
    const reading = guarded.open(scope, epochKey, wire);
    await entered.promise;
    revoked = true;
    release.resolve();
    await expect(reading).rejects.toThrow('revoked');
  });

  it('fails when the platform random source fails, instead of emitting a fallback envelope', async () => {
    const broken = new ContentCipher(
      { authorize: () => alicePublic },
      {
        subtle: crypto.subtle,
        getRandomValues() {
          throw new Error('random-unavailable');
        },
      }
    );
    await expect(
      broken.seal({
        scope,
        author,
        epochKey,
        signingKey: alice.privateKey,
        plaintext: encoder.encode('secret'),
      })
    ).rejects.toThrow('random-unavailable');
  });

  it('exchanges encrypted real Loro updates and snapshots without changing the CRDT bytes', async () => {
    const bobPublic = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', bob.publicKey)));
    const peers = new ContentCipher({
      authorize(header) {
        if (header.actor === 'A' && header.memberInstance === 'A1' && header.device === 'desktop')
          return alicePublic;
        if (header.actor === 'B' && header.memberInstance === 'B1' && header.device === 'phone')
          return bobPublic;
        throw new Error('unknown-peer');
      },
    });
    const a = new LoroDoc();
    const b = new LoroDoc();
    a.setPeerId('1');
    b.setPeerId('2');
    a.getText('text').insert(0, 'private A');
    b.getText('text').insert(0, 'private B');
    const aWire = await seal(a.export({ mode: 'update' }));
    const bWire = await peers.seal({
      scope,
      author: { actor: 'B', memberInstance: 'B1', device: 'phone' },
      epochKey,
      signingKey: bob.privateKey,
      plaintext: b.export({ mode: 'update' }),
    });
    a.import((await peers.open(scope, epochKey, bWire)).plaintext);
    b.import((await peers.open(scope, epochKey, aWire)).plaintext);
    expect(a.toJSON()).toEqual(b.toJSON());
    const snapshotScope: ContentScope = { ...scope, purpose: 'doc-snapshot' };
    const snapshot = await seal(a.export({ mode: 'snapshot' }), snapshotScope);
    const restored = new LoroDoc();
    restored.import((await cipher().open(snapshotScope, epochKey, snapshot)).plaintext);
    expect(restored.toJSON()).toEqual(a.toJSON());
    const before = b.toJSON();
    const bad = aWire.slice();
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    await expect(
      (async () => b.import((await cipher().open(scope, epochKey, bad)).plaintext))()
    ).rejects.toThrow();
    expect(b.toJSON()).toEqual(before);
    a.free();
    b.free();
    restored.free();
  });

  it('round-trips a real Flock file snapshot through the same envelope with separate purpose', async () => {
    const a = new Flock('a');
    const b = new Flock('b');
    a.put(['private', 'one'], { value: 'secret' });
    const context: ContentScope = { ...scope, resource: 'flock-meta', purpose: 'flock-snapshot' };
    const wire = await seal(a.exportFile(), context);
    b.importFile((await cipher().open(context, epochKey, wire)).plaintext);
    expect(b.get(['private', 'one'])).toEqual({ value: 'secret' });
  });
});
