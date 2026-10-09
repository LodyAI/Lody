import { hkdfSync } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { LoroDoc } from 'loro-crdt';
import { Flock } from '@loro-dev/flock-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Effect, Result } from 'effect';
import {
  ContentCipher,
  inspectContent,
  MAX_CONTENT_BYTES,
  type ContentScope,
} from '../src/content';
import { contentRuntimeLayer } from '../src/platform/content';
import { ContentCrypto } from '../src/ports/content';
import {
  contentAad,
  contentKeyInfo,
  contentSigningBytes,
  CONTENT_HKDF_SALT,
  encodeContentContext,
  inspectContentFrame,
} from '../src/pure/content-frame';
import { openContent, sealContent } from '../src/workflows/content';
import { fromHex, toHex } from '../src/wire';
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
const author = { actor: 'A', memberInstance: 'A1', device: '' };
let alice: CryptoKeyPair;
let bob: CryptoKeyPair;
let alicePublic: string;
beforeAll(async () => {
  alice = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])) as CryptoKeyPair;
  bob = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])) as CryptoKeyPair;
  alicePublic = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', alice.publicKey)));
  author.device = alicePublic;
});
function cipher() {
  return new ContentCipher({
    authorize(header) {
      if (header.device !== alicePublic) throw new Error('unauthorized-author');
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
  return {
    length: 37,
    header: wire.slice(0, 37),
    nonce: wire.slice(37, 61),
    ciphertext: wire.slice(61, -64),
  };
}
function keyFor(context: ContentScope) {
  return new Uint8Array(
    hkdfSync('sha256', epochKey, CONTENT_HKDF_SALT, Result.getOrThrow(contentKeyInfo(context)), 32)
  );
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

  it('uses canonical binary context, one AEAD tag and fresh nonce for each seal', async () => {
    const plain = encoder.encode('private content');
    const first = await seal(plain);
    const second = await seal(plain);
    const a = parts(first);
    expect(a.nonce).not.toEqual(parts(second).nonce);
    expect(first.byteLength).toBe(plain.byteLength + 141);
    expect(a.header[0]).toBe(2);
    expect(new DataView(a.header.buffer).getUint32(1)).toBe(0);
    expect(toHex(a.header.subarray(5))).toBe(alicePublic);
    const context = Result.getOrThrow(encodeContentContext(scope));
    expect(toHex(context)).toBe(scope.genesis + '000000000005646f632d3101');
    expect(
      xchacha20poly1305(
        keyFor(scope),
        a.nonce,
        Result.getOrThrow(contentAad(scope, a.header))
      ).decrypt(a.ciphertext)
    ).toEqual(plain);
    expect((await cipher().open(scope, epochKey, first)).plaintext).toEqual(plain);
    await expect(cipher().open(scope, new Uint8Array(32).fill(8), first)).rejects.toThrow(
      'content-authentication-failed'
    );
  });

  it('reproduces bytes from an injected nonce source without a message ID', async () => {
    function scripted() {
      return new ContentCipher(
        { authorize: () => alicePublic },
        {
          subtle: crypto.subtle,
          getRandomValues(array) {
            const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
            expect(view.byteLength).toBe(24);
            view.fill(4);
            return array;
          },
        }
      );
    }
    const input = {
      scope,
      author,
      epochKey,
      signingKey: alice.privateKey,
      plaintext: encoder.encode('replay-me'),
    };
    expect(await scripted().seal(input)).toEqual(await scripted().seal(input));
  });

  it('binds independently supplied Org, epoch, document and purpose in signature, AAD and key derivation', async () => {
    const wire = await seal(encoder.encode('secret'));
    const alternatives: ContentScope[] = [
      { ...scope, genesis: '02'.repeat(32) },
      { ...scope, epoch: 1 },
      { ...scope, resource: 'doc-2' },
      { ...scope, purpose: 'doc-snapshot' },
    ];
    const { nonce, header, ciphertext } = parts(wire);
    for (const context of alternatives) {
      await expect(cipher().open(context, epochKey, wire)).rejects.toThrow();
      await expect(cipher().authenticate(context, wire)).rejects.toThrow();
      expect(() =>
        xchacha20poly1305(
          keyFor(context),
          nonce,
          Result.getOrThrow(contentAad(context, header))
        ).decrypt(ciphertext)
      ).toThrow();
      // Even the genuine signer cannot rebind existing ciphertext by signing a new context.
      const unsigned = wire.slice(0, -64);
      if (context.epoch !== scope.epoch) new DataView(unsigned.buffer).setUint32(1, context.epoch);
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          alice.privateKey,
          Result.getOrThrow(contentSigningBytes(context, unsigned))
        )
      );
      await expect(
        cipher().open(context, epochKey, Buffer.concat([unsigned, signature]))
      ).rejects.toThrow('content-authentication-failed');
    }
  });

  it('rejects unknown versions and unregistered or mismatched signing keys', async () => {
    const wire = await seal(encoder.encode('secret'));
    for (const version of [0, 1, 3, 255]) {
      const changed = wire.slice();
      changed[0] = version;
      expect(() => inspectContent(changed)).toThrow('unsupported-content-version');
      expect(Result.isFailure(inspectContentFrame(changed))).toBe(true);
    }
    expect(inspectContent(wire)).toEqual({ version: 2, epoch: 0, device: alicePublic });
    expect(await cipher().authenticate(scope, wire)).toEqual({ ...scope, device: alicePublic });
    const refusing = new ContentCipher({
      authorize: () => {
        throw new Error('not-admitted');
      },
    });
    await expect(refusing.authenticate(scope, wire)).rejects.toThrow('not-admitted');
    const weak = new ContentCipher({ authorize: () => '01' + '00'.repeat(31) });
    await expect(weak.open(scope, epochKey, wire)).rejects.toThrow('invalid-signing-key');
  });

  it('rejects tampering in header, nonce, body, tag or signature without releasing plaintext', async () => {
    const wire = await seal(encoder.encode('secret'));
    const { length } = parts(wire);
    for (const position of [0, 1, 5, length, 24 + length, wire.length - 65, wire.length - 1]) {
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
        author: {
          ...author,
          device: toHex(new Uint8Array(await crypto.subtle.exportKey('raw', bob.publicKey))),
        },
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
        if (header.device === alicePublic) return alicePublic;
        if (header.device === bobPublic) return bobPublic;
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
      author: { actor: 'B', memberInstance: 'B1', device: bobPublic },
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

  it('re-runs the same seal and open Effects without consuming captured secrets', async () => {
    const layer = contentRuntimeLayer(
      {
        authorize(header) {
          if (header.device !== alicePublic) throw new Error('unauthorized-author');
          return alicePublic;
        },
      },
      globalThis.crypto
    );
    const key = epochKey.slice();
    const data = encoder.encode('hello');
    const sealing = sealContent({
      scope,
      author,
      epochKey: key,
      signingKey: alice.privateKey,
      plaintext: data,
    }).pipe(Effect.provide(layer));
    key.fill(0);
    data.fill(0);
    const first = await Effect.runPromise(sealing);
    const second = await Effect.runPromise(sealing);
    expect(first).not.toEqual(second);
    const opening = openContent(scope, epochKey, first).pipe(Effect.provide(layer));
    expect(decoder.decode((await Effect.runPromise(opening)).plaintext)).toBe('hello');
    expect(decoder.decode((await Effect.runPromise(opening)).plaintext)).toBe('hello');
    expect(decoder.decode((await cipher().open(scope, epochKey, second)).plaintext)).toBe('hello');
  });

  it('reuses the derivation Service Effect without consuming its captured input', async () => {
    const layer = contentRuntimeLayer({ authorize: () => alicePublic }, globalThis.crypto);
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ContentCrypto;
        const header = { ...scope };
        const input = new Uint8Array(epochKey);
        const task = service.derive(input, header);
        input.fill(0);
        const expected = yield* service.derive(epochKey, header);
        const first = yield* task;
        const second = yield* task;
        expect(first).toEqual(expected);
        expect(second).toEqual(expected);
        first.fill(0);
        expect(second).toEqual(expected);
        const concurrent = yield* Effect.all([task, task], { concurrency: 'unbounded' });
        expect(concurrent).toEqual([expected, expected]);
      }).pipe(Effect.provide(layer))
    );
  });

  it('seals the same Effect concurrently without sharing wiped working buffers', async () => {
    const layer = contentRuntimeLayer({ authorize: () => alicePublic }, globalThis.crypto);
    const sealing = sealContent({
      scope,
      author,
      epochKey,
      signingKey: alice.privateKey,
      plaintext: encoder.encode('hello'),
    }).pipe(Effect.provide(layer));
    const [left, right] = await Effect.runPromise(
      Effect.all([sealing, sealing], { concurrency: 'unbounded' })
    );
    expect(left).not.toEqual(right);
    expect(decoder.decode((await cipher().open(scope, epochKey, left)).plaintext)).toBe('hello');
    expect(decoder.decode((await cipher().open(scope, epochKey, right)).plaintext)).toBe('hello');
  });

  it('retries the same seal Effect after a failed key derivation', async () => {
    let remainingFailures = 1;
    const platform = {
      getRandomValues: crypto.getRandomValues.bind(crypto),
      subtle: new Proxy(crypto.subtle, {
        get(target, prop) {
          if (prop === 'deriveBits')
            return async (...args: Parameters<SubtleCrypto['deriveBits']>) => {
              if (remainingFailures > 0) {
                remainingFailures -= 1;
                throw new DOMException('temporary-derive-failure', 'OperationError');
              }
              return target.deriveBits(...args);
            };
          const value: unknown = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    };
    const layer = contentRuntimeLayer({ authorize: () => alicePublic }, platform);
    const sealing = sealContent({
      scope,
      author,
      epochKey,
      signingKey: alice.privateKey,
      plaintext: encoder.encode('hello'),
    }).pipe(Effect.provide(layer));
    const first = await Effect.runPromise(Effect.result(sealing));
    expect(Result.isFailure(first) && first.failure._tag).toBe('CryptoError');
    const wire = await Effect.runPromise(sealing);
    expect(decoder.decode((await cipher().open(scope, epochKey, wire)).plaintext)).toBe('hello');
  });
});

it('bounds canonical epoch/context/frame lengths and separates every content purpose', async () => {
  for (const epoch of [-1, 0x100000000, 1.5, NaN])
    await expect(seal(new Uint8Array(), { ...scope, epoch })).rejects.toThrow(
      'invalid-content-epoch'
    );
  const last = await seal(new Uint8Array(), { ...scope, epoch: 0xffffffff });
  expect(inspectContent(last).epoch).toBe(0xffffffff);
  expect(
    (await cipher().open({ ...scope, epoch: 0xffffffff }, epochKey, last)).plaintext.byteLength
  ).toBe(0);
  for (const resource of ['', 'x'.repeat(1025), '文档', 'has space'])
    await expect(seal(new Uint8Array(), { ...scope, resource })).rejects.toThrow(
      'invalid-content-resource'
    );
  for (let size = 0; size < 141; size++)
    expect(Result.isFailure(inspectContentFrame(new Uint8Array(size)))).toBe(true);
  expect(Result.isFailure(inspectContentFrame(new Uint8Array(MAX_CONTENT_BYTES + 142)))).toBe(true);
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
  for (const purpose of purposes) {
    const bound = { ...scope, purpose };
    const frame = await seal(encoder.encode(purpose), bound);
    expect(decoder.decode((await cipher().open(bound, epochKey, frame)).plaintext)).toBe(purpose);
    for (const other of purposes)
      if (other !== purpose)
        await expect(cipher().open({ ...scope, purpose: other }, epochKey, frame)).rejects.toThrow(
          'bad-content-signature'
        );
  }
});

it('wipes run-owned epoch and derived keys on successful seal/open and failed signing', async () => {
  const { contentCryptoLayer, contentAuthorityLayer } = await import('../src/platform/content');
  const { CryptoError } = await import('../src/pure/errors');
  const { Layer } = await import('effect');
  const owned: Uint8Array[] = [];
  let failSigning = true;
  const instrumented = Layer.effect(
    ContentCrypto,
    Effect.gen(function* () {
      const cryptoService = yield* ContentCrypto;
      return {
        ...cryptoService,
        derive: (input: Uint8Array<ArrayBuffer>, header: ContentScope) => {
          owned.push(input);
          return cryptoService.derive(input, header).pipe(
            Effect.tap((key) =>
              Effect.sync(() => {
                owned.push(key);
              })
            )
          );
        },
        sign: (key: CryptoKey, message: Uint8Array) =>
          failSigning
            ? Effect.fail(new CryptoError({ operation: 'sign' }))
            : cryptoService.sign(key, message),
      };
    })
  ).pipe(Layer.provide(contentCryptoLayer(globalThis.crypto)));
  const layer = Layer.merge(contentAuthorityLayer({ authorize: () => alicePublic }), instrumented);
  const inputKey = epochKey.slice();
  const task = sealContent({
    scope,
    author,
    epochKey: inputKey,
    signingKey: alice.privateKey,
    plaintext: encoder.encode('cleanup'),
  }).pipe(Effect.provide(layer));
  const failure = await Effect.runPromise(Effect.result(task));
  expect(Result.isFailure(failure) && failure.failure._tag).toBe('CryptoError');
  expect(owned.length).toBeGreaterThan(0);
  for (const key of owned) expect(key.every((b) => b === 0)).toBe(true);
  failSigning = false;
  const frame = await Effect.runPromise(task);
  for (const key of owned) expect(key.every((b) => b === 0)).toBe(true);
  const opened = await Effect.runPromise(
    openContent(scope, inputKey, frame).pipe(Effect.provide(layer))
  );
  expect(decoder.decode(opened.plaintext)).toBe('cleanup');
  for (const key of owned) expect(key.every((b) => b === 0)).toBe(true);
  expect(inputKey).toEqual(epochKey);
});

it('wipes acquired secrets when interrupted during signing, without sharing caller buffers', async () => {
  const { Deferred, Fiber, Layer } = await import('effect');
  const { contentCryptoLayer, contentAuthorityLayer } = await import('../src/platform/content');
  const owned: Uint8Array[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const signing = yield* Deferred.make<void>();
      const instrumented = Layer.effect(
        ContentCrypto,
        Effect.gen(function* () {
          const service = yield* ContentCrypto;
          return {
            ...service,
            derive: (input: Uint8Array<ArrayBuffer>, header: ContentScope) => {
              owned.push(input);
              return service.derive(input, header).pipe(
                Effect.tap((key) =>
                  Effect.sync(() => {
                    owned.push(key);
                  })
                )
              );
            },
            sign: () => Deferred.succeed(signing, undefined).pipe(Effect.andThen(Effect.never)),
          };
        })
      ).pipe(Layer.provide(contentCryptoLayer(globalThis.crypto)));
      const layer = Layer.merge(
        contentAuthorityLayer({ authorize: () => alicePublic }),
        instrumented
      );
      const child = yield* Effect.forkChild(
        sealContent({
          scope,
          author,
          epochKey,
          signingKey: alice.privateKey,
          plaintext: encoder.encode('interruption'),
        }).pipe(Effect.provide(layer))
      );
      yield* Deferred.await(signing);
      yield* Fiber.interrupt(child);
      expect(owned.length).toBeGreaterThan(0);
      for (const key of owned) expect(key.every((b) => b === 0)).toBe(true);
      expect(epochKey).toEqual(new Uint8Array(32).fill(7));
    })
  );
});

it('authenticates external AAD without storing it and rejects re-signed ciphertext under another AAD', async () => {
  const plaintext = encoder.encode('small update');
  const binding = new Uint8Array([6, 7, 8]);
  const other = new Uint8Array([6, 7, 9]);
  const c = cipher();
  const frame = await c.seal({
    scope,
    author,
    epochKey,
    signingKey: alice.privateKey,
    plaintext,
    additionalData: binding,
  });
  expect(frame.byteLength).toBe(plaintext.byteLength + 141);
  expect((await c.open(scope, epochKey, frame, binding)).plaintext).toEqual(plaintext);
  expect((await c.authenticate(scope, frame, binding)).device).toBe(alicePublic);
  for (const wrong of [undefined, new Uint8Array(), other, new Uint8Array([6, 7])]) {
    await expect(c.open(scope, epochKey, frame, wrong)).rejects.toThrow('bad-content-signature');
    await expect(c.authenticate(scope, frame, wrong)).rejects.toThrow('bad-content-signature');
  }
  const unsigned = frame.slice(0, -64);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'Ed25519',
      alice.privateKey,
      new Uint8Array(Result.getOrThrow(contentSigningBytes(scope, unsigned, other)))
    )
  );
  const rebound = frame.slice();
  rebound.set(signature, unsigned.byteLength);
  // The legitimate signer can re-sign, but changing external AAD still cannot
  // make the original AEAD ciphertext valid under the replacement context.
  await expect(c.authenticate(scope, rebound, other)).resolves.toMatchObject({
    device: alicePublic,
  });
  await expect(c.open(scope, epochKey, rebound, other)).rejects.toThrow(
    'content-authentication-failed'
  );
  const invalid = new Uint8Array(1025);
  await expect(
    c.seal({
      scope,
      author,
      epochKey,
      signingKey: alice.privateKey,
      plaintext,
      additionalData: invalid,
    })
  ).rejects.toThrow('invalid-content-additional-data');
  await expect(c.open(scope, epochKey, frame, invalid)).rejects.toThrow(
    'invalid-content-additional-data'
  );
  await expect(c.authenticate(scope, frame, invalid)).rejects.toThrow(
    'invalid-content-additional-data'
  );
  const maximum = new Uint8Array(1024).fill(1);
  const largeAadFrame = await c.seal({
    scope,
    author,
    epochKey,
    signingKey: alice.privateKey,
    plaintext,
    additionalData: maximum,
  });
  expect(largeAadFrame.byteLength).toBe(frame.byteLength);
  expect((await c.open(scope, epochKey, largeAadFrame, maximum)).plaintext).toEqual(plaintext);
});

it('captures external AAD before execution and keeps repeat/concurrent Effects independent', async () => {
  const layer = contentRuntimeLayer({ authorize: () => alicePublic }, globalThis.crypto);
  const binding = new Uint8Array([6, 7, 8]);
  const expected = binding.slice();
  const task = sealContent({
    scope,
    author,
    epochKey,
    signingKey: alice.privateKey,
    plaintext: encoder.encode('captured AAD'),
    additionalData: binding,
  }).pipe(Effect.provide(layer));
  binding.fill(0);
  const frames = await Effect.runPromise(Effect.all([task, task], { concurrency: 'unbounded' }));
  const opening = openContent(scope, epochKey, frames[0]!, expected).pipe(Effect.provide(layer));
  expected.fill(0);
  for (let run = 0; run < 2; run++)
    expect(decoder.decode((await Effect.runPromise(opening)).plaintext)).toBe('captured AAD');
  expect(
    decoder.decode(
      (await cipher().open(scope, epochKey, frames[1]!, new Uint8Array([6, 7, 8]))).plaintext
    )
  ).toBe('captured AAD');
});
