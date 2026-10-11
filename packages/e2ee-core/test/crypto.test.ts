import { hkdfSync, createPrivateKey, sign } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Result } from 'effect';
import {
  Bytes,
  deriveContentKey,
  sealContentAead,
  openContentAead,
  contentKeyInfo,
  contentHkdfSalt,
  contentAad,
  encodeContentHeader,
  contentSigningBytes,
  verifyContentSignature,
  type ContentHeader,
  type ContentKey,
  type ContentScope,
} from '@lody/e2ee-core';
import vectors from './crypto-vector.json';

const read = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result);
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
const header: ContentHeader = {
  genesis: '11'.repeat(32),
  epoch: 0x01020304,
  docEpoch: 0,
  resource: 'doc',
  purpose: 'doc-update',
  device: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
};
const source = new Uint8Array(32).fill(7);
const keyFor = (scope: ContentScope = header, secret = source) =>
  read(deriveContentKey(read(Bytes.epochKey(secret)), scope));
const nativeKey = (scope: ContentScope) =>
  new Uint8Array(hkdfSync('sha256', source, readSalt(), read(contentKeyInfo(scope)), 32));
const readSalt = () => contentHkdfSalt();
function fixedRandom(value = bytes(vectors.nonce)) {
  vi.stubGlobal('crypto', {
    getRandomValues: (out: Uint8Array) => {
      out.set(value);
      return out;
    },
  });
}
function code(result: Result.Result<unknown, { code: string }>) {
  expect(Result.isFailure(result)).toBe(true);
  return Result.isFailure(result) ? result.failure.code : undefined;
}
afterEach(() => vi.unstubAllGlobals());

describe('public scoped content crypto', () => {
  it('wipes temporary copies after random-source and authentication failure, retaining the leaf', () => {
    const key = keyFor();
    const expectedKey = nativeKey(header);
    const NativeBytes = Uint8Array;
    const copies: Array<{ before: Uint8Array; after: Uint8Array }> = [];
    vi.stubGlobal(
      'Uint8Array',
      new Proxy(NativeBytes, {
        construct(target, args) {
          const output = Reflect.construct(target, args) as Uint8Array;
          const input: unknown = args[0];
          if (input instanceof NativeBytes)
            copies.push({ before: new NativeBytes(input), after: output });
          return output;
        },
      })
    );
    const plaintext = new NativeBytes([1, 2, 3]);
    vi.stubGlobal('crypto', {
      getRandomValues: () => {
        throw new Error('synthetic failure');
      },
    });
    expect(code(sealContentAead(key, header, plaintext))).toBe('content-random-unavailable');
    const secret = copies.find(({ before }) => Buffer.compare(before, expectedKey) === 0)!;
    const owned = copies.find(({ before }) => Buffer.compare(before, plaintext) === 0)!;
    expect(secret.after).toEqual(new NativeBytes(32));
    expect(owned.after).toEqual(new NativeBytes(plaintext.length));
    expect(plaintext).toEqual(new NativeBytes([1, 2, 3]));
    fixedRandom();
    const sealed = read(sealContentAead(key, header, plaintext));
    copies.length = 0;
    const damaged = sealed.ciphertext.slice();
    damaged[0] ^= 1;
    expect(code(openContentAead(key, header, sealed.nonce, damaged))).toBe(
      'content-authentication-failed'
    );
    const openingSecret = copies.find(({ before }) => Buffer.compare(before, expectedKey) === 0)!;
    expect(openingSecret.after).toEqual(new NativeBytes(32));
    expect(read(openContentAead(key, header, sealed.nonce, sealed.ciphertext))).toEqual(plaintext);
  });

  it('composes with native Ed25519 and rejects legitimately re-signed ciphertext under another binding', () => {
    fixedRandom();
    const key = keyFor();
    const binding = bytes('abcd');
    const sealed = read(sealContentAead(key, header, new Uint8Array([9]), binding));
    const unsigned = new Uint8Array(
      Buffer.concat([read(encodeContentHeader(header)), sealed.nonce, sealed.ciphertext])
    );
    const privateKey = createPrivateKey({
      key: Buffer.from(
        '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
        'hex'
      ),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKey = read(Bytes.signingPublicKey(bytes(header.device)));
    const frameFor = (aad: Uint8Array) =>
      new Uint8Array(
        Buffer.concat([
          unsigned,
          sign(null, read(contentSigningBytes(header, unsigned, aad)), privateKey),
        ])
      );
    const original = frameFor(binding);
    expect(read(verifyContentSignature(original, header, publicKey, binding))).toMatchObject({
      epoch: header.epoch,
      device: header.device,
    });
    expect(
      read(
        openContentAead(key, header, original.subarray(39, 63), original.subarray(63, -64), binding)
      )
    ).toEqual(new Uint8Array([9]));
    const other = bytes('abce');
    const rebound = frameFor(other);
    expect(Result.isSuccess(verifyContentSignature(rebound, header, publicKey, other))).toBe(true);
    expect(
      code(openContentAead(key, header, rebound.subarray(39, 63), rebound.subarray(63, -64), other))
    ).toBe('content-authentication-failed');
  });
  it.each(vectors.cases)(
    'matches independent Python HMAC + libsodium vector: $purpose / $binding',
    (vector) => {
      fixedRandom();
      const scope = { ...header, purpose: vector.purpose as ContentScope['purpose'] };
      const key = keyFor(scope);
      const binding = bytes(vector.binding);
      expect(hex(nativeKey(scope))).toBe(vector.key);
      const sealed = read(sealContentAead(key, scope, bytes(vector.plaintext), binding));
      expect(hex(sealed.nonce)).toBe(vectors.nonce);
      expect(hex(sealed.ciphertext)).toBe(vector.ciphertext);
      expect(hex(read(openContentAead(key, scope, sealed.nonce, sealed.ciphertext, binding)))).toBe(
        vector.plaintext
      );
    }
  );

  it('matches native WebCrypto HKDF for every purpose and rejects purpose rebinding', async () => {
    const purposes = [
      'doc-update',
      'doc-snapshot',
      'flock-update',
      'flock-snapshot',
      'blob',
      'epoch-history',
      'presence',
      'rpc-request',
      'rpc-response',
    ] as const;
    const platform = globalThis.crypto;
    fixedRandom();
    const nativeMaterial = await platform.subtle.importKey('raw', source, 'HKDF', false, [
      'deriveBits',
    ]);
    for (const purpose of purposes) {
      const scope = { ...header, purpose };
      const expected = new Uint8Array(
        await platform.subtle.deriveBits(
          { name: 'HKDF', hash: 'SHA-256', salt: readSalt(), info: read(contentKeyInfo(scope)) },
          nativeMaterial,
          256
        )
      );
      expect(expected).toEqual(nativeKey(scope));
      const sealed = read(sealContentAead(keyFor(scope), scope, new Uint8Array([9])));
      const aad = read(contentAad(scope, read(encodeContentHeader(scope))));
      expect(sealed.ciphertext).toEqual(
        xchacha20poly1305(expected, sealed.nonce, aad).encrypt(new Uint8Array([9]))
      );
      if (purpose !== 'doc-update') {
        const result = openContentAead(keyFor(scope), header, sealed.nonce, sealed.ciphertext);
        expect(code(result)).toBe(
          purposes.indexOf(purpose) < 4
            ? 'content-authentication-failed'
            : 'content-key-scope-mismatch'
        );
      }
    }
    const shared = keyFor();
    for (const purpose of purposes.slice(0, 4))
      expect(
        Result.isSuccess(sealContentAead(shared, { ...header, purpose }, new Uint8Array()))
      ).toBe(true);
  });

  it('rejects wrong context even with freshly derived keys and authenticates the trusted signer header', () => {
    fixedRandom();
    const sealed = read(sealContentAead(keyFor(), header, new Uint8Array([1, 2, 3])));
    const alternatives: ContentHeader[] = [
      { ...header, genesis: '12'.repeat(32) },
      { ...header, epoch: 5 },
      { ...header, resource: 'other' },
      { ...header, purpose: 'doc-snapshot' },
      { ...header, device: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c' },
    ];
    for (const scope of alternatives) {
      expect(code(openContentAead(keyFor(scope), scope, sealed.nonce, sealed.ciphertext))).toBe(
        'content-authentication-failed'
      );
    }
    for (const scope of alternatives.slice(0, 3)) {
      expect(code(openContentAead(keyFor(), scope, sealed.nonce, sealed.ciphertext))).toBe(
        'content-key-scope-mismatch'
      );
      expect(code(sealContentAead(keyFor(), scope, new Uint8Array()))).toBe(
        'content-key-scope-mismatch'
      );
    }
    expect(
      code(
        openContentAead(keyFor(header, new Uint8Array(32)), header, sealed.nonce, sealed.ciphertext)
      )
    ).toBe('content-authentication-failed');
  });

  it('rejects damaged nonce, ciphertext, tag and external binding, releasing no plaintext', () => {
    fixedRandom();
    const key = keyFor();
    const binding = bytes('abcd');
    const sealed = read(sealContentAead(key, header, new Uint8Array([1, 2, 3]), binding));
    for (const offset of [0, 2, sealed.ciphertext.length - 1]) {
      const changed = sealed.ciphertext.slice();
      changed[offset] ^= 1;
      expect(code(openContentAead(key, header, sealed.nonce, changed, binding))).toBe(
        'content-authentication-failed'
      );
    }
    const nonce = sealed.nonce.slice();
    nonce[0] ^= 1;
    expect(code(openContentAead(key, header, nonce, sealed.ciphertext, binding))).toBe(
      'content-authentication-failed'
    );
    for (const wrong of [undefined, new Uint8Array(), bytes('abce')]) {
      expect(code(openContentAead(key, header, sealed.nonce, sealed.ciphertext, wrong))).toBe(
        'content-authentication-failed'
      );
    }
    expect(read(openContentAead(key, header, sealed.nonce, sealed.ciphertext, binding))).toEqual(
      new Uint8Array([1, 2, 3])
    );
  });

  it('checks nonce, ciphertext and plaintext lengths before crypto', () => {
    fixedRandom();
    const key = keyFor();
    const nonce = new Uint8Array(24);
    for (const size of [0, 23, 25])
      expect(code(openContentAead(key, header, new Uint8Array(size), new Uint8Array(16)))).toBe(
        'invalid-content-nonce'
      );
    for (const size of [0, 15, 16 * 1024 * 1024 + 17])
      expect(code(openContentAead(key, header, nonce, new Uint8Array(size)))).toBe(
        'invalid-content-ciphertext'
      );
    expect(code(sealContentAead(key, header, new Uint8Array(16 * 1024 * 1024 + 1)))).toBe(
      'content-too-large'
    );
    expect(code(sealContentAead(key, header, null as unknown as Uint8Array))).toBe(
      'invalid-content-plaintext'
    );
    expect(code(openContentAead(key, header, nonce, null as unknown as Uint8Array))).toBe(
      'invalid-content-ciphertext'
    );
    const empty = read(sealContentAead(key, header, new Uint8Array()));
    expect(empty.ciphertext.length).toBe(16);
    expect(read(openContentAead(key, header, empty.nonce, empty.ciphertext))).toEqual(
      new Uint8Array()
    );
  });

  it('accepts exact payload and binding limits with nonzero view offsets', () => {
    fixedRandom();
    const key = keyFor();
    const data = new Uint8Array(16 * 1024 * 1024 + 1).fill(37).subarray(1);
    const binding = new Uint8Array(1025).fill(3).subarray(1);
    const sealed = read(sealContentAead(key, header, data, binding));
    expect(sealed.ciphertext.length).toBe(data.length + 16);
    const padded = new Uint8Array(sealed.ciphertext.length + 1);
    padded.set(sealed.ciphertext, 1);
    const opened = read(openContentAead(key, header, sealed.nonce, padded.subarray(1), binding));
    expect(opened.byteLength).toBe(data.byteLength);
    expect(Buffer.compare(opened, data)).toBe(0);
    expect(code(sealContentAead(key, header, data, new Uint8Array(1025)))).toBe(
      'invalid-content-additional-data'
    );
    expect(
      code(openContentAead(key, header, sealed.nonce, sealed.ciphertext, new Uint8Array(1025)))
    ).toBe('invalid-content-additional-data');
  });

  it('rejects invalid secrets/scopes and cannot forge an opaque key', () => {
    for (const epoch of [-1, 0.5, NaN, 0x100000000])
      expect(code(deriveContentKey(read(Bytes.epochKey(source)), { ...header, epoch }))).toBe(
        'invalid-content-epoch'
      );
    for (const docEpoch of [1, -1, NaN, 0.5, 65536])
      expect(code(deriveContentKey(read(Bytes.epochKey(source)), { ...header, docEpoch }))).toBe(
        'unsupported-document-epoch'
      );
    expect(code(deriveContentKey({} as Bytes.EpochKey, header))).toBe('invalid-content-key');
    expect(
      code(
        deriveContentKey(read(Bytes.epochKey(source)), {
          ...header,
          purpose: 'unknown' as ContentScope['purpose'],
        })
      )
    ).toBe('invalid-content-purpose');
    expect(code(sealContentAead({} as ContentKey, header, new Uint8Array()))).toBe(
      'invalid-content-key'
    );
    expect(
      code(
        deriveContentKey(read(Bytes.epochKey(source)), { ...header, resource: 'x'.repeat(1025) })
      )
    ).toBe('invalid-content-resource');
    expect(
      Result.isSuccess(
        deriveContentKey(read(Bytes.epochKey(source)), {
          ...header,
          resource: 'x'.repeat(1024),
          epoch: 0xffffffff,
        })
      )
    ).toBe(true);
  });

  it('fails closed when secure randomness is absent or throws and preserves a reusable key', () => {
    const key = keyFor();
    for (const platform of [
      undefined,
      {},
      {
        getRandomValues: () => {
          throw new Error('synthetic private diagnostic');
        },
      },
    ]) {
      vi.stubGlobal('crypto', platform);
      const result = sealContentAead(key, header, new Uint8Array([1]));
      expect(code(result)).toBe('content-random-unavailable');
      if (Result.isFailure(result))
        expect(JSON.stringify(result.failure)).not.toContain('synthetic private');
    }
    fixedRandom();
    const sealed = read(sealContentAead(key, header, new Uint8Array([1])));
    expect(read(openContentAead(key, header, sealed.nonce, sealed.ciphertext))).toEqual(
      new Uint8Array([1])
    );
  });

  it('captures secret, scope, binding and plaintext; obtains a fresh host nonce per new encryption', () => {
    const material = source.slice();
    const epochKey = read(Bytes.epochKey(material));
    material.fill(0);
    const scope = { ...header };
    const key = read(deriveContentKey(epochKey, scope));
    scope.resource = 'changed';
    const plaintext = new Uint8Array([8]);
    const binding = new Uint8Array([6]);
    let value = 0;
    vi.stubGlobal('crypto', {
      getRandomValues: (out: Uint8Array) => {
        out.fill(++value);
        plaintext.fill(0);
        binding.fill(0);
        return out;
      },
    });
    const first = read(sealContentAead(key, header, plaintext, binding));
    expect(
      read(openContentAead(key, header, first.nonce, first.ciphertext, new Uint8Array([6])))
    ).toEqual(new Uint8Array([8]));
    const second = read(sealContentAead(key, header, new Uint8Array([8]), new Uint8Array([6])));
    expect(first.nonce).not.toEqual(second.nonce);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(Object.keys(key)).toEqual([]);
    expect(Object.isFrozen(key)).toBe(true);
  });
});
