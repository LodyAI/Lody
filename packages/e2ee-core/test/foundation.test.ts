import { describe, expect, it, vi } from 'vitest';
import { Cause, Effect, Exit, Fiber, Result } from 'effect';
import { Point } from '@noble/ed25519';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { verifySignatureEffect } from '../src/internal/foundation/signature';
import { signVerified } from '../src/internal/foundation/signing';
import {
  Bytes,
  decodeCbor,
  encodeCbor,
  encodeDocumentContext,
  encodeContentContext,
  encodeContentHeader,
  contentKeyInfo,
  contentHkdfSalt,
  contentAad,
  contentSigningBytes,
  inspectContentFrame,
  verifySignature,
  verifyContentSignature,
  type ContentScope,
  type ContentPurpose,
  type CborValue,
} from '../src/protocol';
import vector from './content-vector.json';

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
function ok<A, E extends Error>(result: Result.Result<A, E>): A {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}
const scope: ContentScope = {
  genesis: '11'.repeat(32),
  epoch: 0x01020304,
  resource: 'doc',
  purpose: 'doc-update',
};
const key = ok(Bytes.signingPublicKey(hex(vector.publicKey)));
const frame = () => hex(vector.frame);

// RFC 8032 section 7.1, test 1 (empty message). No generated key/signature pair.
const rfcSig = hex(
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555f' +
    'b8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'
);

describe('owned public bytes and secrets', () => {
  it('copies input/output and keeps brands separate', () => {
    const input = hex(vector.publicKey);
    const signing = ok(Bytes.signingPublicKey(input));
    input.fill(0);
    signing.toBytes().fill(0);
    expect(signing.toBytes()).toEqual(hex(vector.publicKey));
    expect(signing.equals(key)).toBe(true);
    const genesis = ok(Bytes.genesisHash(key.toBytes()));
    // @ts-expect-error distinct protocol identities must not be interchangeable
    expect(signing.equals(genesis)).toBe(false);
  });
  it('does not expose epoch secret material through serialization', () => {
    const secret = ok(Bytes.epochKey(new Uint8Array(32).fill(0xab)));
    expect(JSON.stringify(secret)).toBe('{}');
    expect('toBytes' in secret).toBe(false);
    expect(Result.isFailure(Bytes.epochKey(new Uint8Array(31)))).toBe(true);
  });
  it.each([null, '00', new Uint8Array(31), new Uint8Array(33)])(
    'rejects malformed keys: %s',
    (value) => {
      expect(Result.isFailure(Bytes.signingPublicKey(value))).toBe(true);
      expect(Result.isFailure(Bytes.encryptionPublicKey(value))).toBe(true);
    }
  );
  it('checks X25519 wire shape without claiming a key agreement', () => {
    expect(Result.isFailure(Bytes.encryptionPublicKey(new Uint8Array(32)))).toBe(true);
    expect(Result.isSuccess(Bytes.encryptionPublicKey(new Uint8Array(32).fill(1)))).toBe(true);
  });
  it.each([-1, 1.5, NaN, Infinity, 2 ** 32])('rejects invalid epoch %s', (epoch) => {
    expect(Result.isFailure(Bytes.epochNumber(epoch))).toBe(true);
  });
});

describe('bounded canonical CBOR', () => {
  it('matches fixed bytes and owns decoded bytes', () => {
    const bytes = hex('8600171818f5f643010203');
    expect(ok(encodeCbor([0, 23, 24, true, null, new Uint8Array([1, 2, 3])]))).toEqual(bytes);
    const decoded = ok(decodeCbor(bytes));
    bytes.fill(0);
    expect(decoded).toEqual([0, 23, 24, true, null, new Uint8Array([1, 2, 3])]);
  });
  it.each(['', '1817', '9f00ff', '00ff', '824101', 'a0', '6161', '20', 'f93c00', 'f7', 'c000'])(
    'rejects malformed/noncanonical bytes %s',
    (wire) => {
      expect(Result.isFailure(decodeCbor(hex(wire)))).toBe(true);
    }
  );
  it('bounds depth, array count, byte strings and total size', () => {
    for (const wire of [
      '81'.repeat(10) + '00',
      '9821' + '00'.repeat(33),
      '590101' + '00'.repeat(257),
    ])
      expect(Result.isFailure(decodeCbor(hex(wire)))).toBe(true);
    expect(Result.isFailure(decodeCbor(new Uint8Array(8193)))).toBe(true);
    expect(Result.isFailure(encodeCbor([new Uint8Array(257)]))).toBe(true);
  });
  it('rejects shared expansion before exhausting the traversal budget', () => {
    // The guard keeps a regression from killing the test runner. It is not a
    // time limit: an 8192-byte encoding cannot contain this many scalar visits.
    let visits = 0;
    const leaf = [0];
    Object.defineProperty(leaf, 0, {
      get: () => {
        if (++visits > 8192) throw new Error('expanded beyond the wire budget');
        return 0;
      },
    });
    let value: CborValue = leaf;
    for (let i = 0; i < 6; i++) value = Array(32).fill(value);
    const result = encodeCbor(value);
    expect(Result.isFailure(result) && result.failure.code).toBe('oversize');
  });
  it('accepts shared values, rejects cycles, and snapshots each input occurrence', () => {
    const shared = [0, new Uint8Array([1])];
    expect(toHex(ok(encodeCbor([shared, shared])))).toBe('828200410182004101');
    const cyclic: CborValue[] = [];
    cyclic.push(cyclic);
    const result = encodeCbor(cyclic);
    expect(Result.isFailure(result) && result.failure.code).toBe('canonical');

    const changing = [0];
    Object.defineProperty(changing, 0, {
      get: () => {
        Object.defineProperty(changing, 0, { value: new Uint8Array(8193) });
        return 0;
      },
      configurable: true,
    });
    expect(toHex(ok(encodeCbor(changing)))).toBe('8100');
  });
  it('preserves the exact 8192-byte limit, including repeated byte strings', () => {
    const shared = new Uint8Array(256);
    const value = [...Array<Uint8Array>(31).fill(shared), new Uint8Array(159)];
    const bytes = ok(encodeCbor(value));
    expect(bytes.byteLength).toBe(8192);
    expect(toHex(bytes)).toBe(
      '9820' + ('590100' + '00'.repeat(256)).repeat(31) + '589f' + '00'.repeat(159)
    );
    expect(ok(decodeCbor(bytes))).toEqual(value);
    value[31] = new Uint8Array(160);
    const result = encodeCbor(value);
    expect(Result.isFailure(result) && result.failure.code).toBe('oversize');
  });
  it('preserves depth, array, byte-string and integer header boundaries', () => {
    let value: CborValue = 0;
    for (let i = 0; i < 8; i++) value = [value];
    expect(toHex(ok(encodeCbor(value)))).toBe('81'.repeat(8) + '00');
    expect(Result.isFailure(encodeCbor([value]))).toBe(true);
    expect(toHex(ok(encodeCbor(Array(32).fill(0))))).toBe('9820' + '00'.repeat(32));
    expect(Result.isFailure(encodeCbor(Array(33).fill(0)))).toBe(true);
    for (const [length, header] of [
      [23, '57'],
      [24, '5818'],
      [255, '58ff'],
      [256, '590100'],
    ] as const) {
      expect(toHex(ok(encodeCbor(new Uint8Array(length))))).toBe(header + '00'.repeat(length));
    }
    expect(
      toHex(
        ok(
          encodeCbor([
            23,
            24,
            255,
            256,
            65535,
            65536,
            0xffffffff,
            0x100000000,
            Number.MAX_SAFE_INTEGER,
          ])
        )
      )
    ).toBe('8917181818ff19010019ffff1a000100001affffffff1b00000001000000001b001fffffffffffff');
  });
});

describe('strict Ed25519', () => {
  it('keeps warmed key validation bound to owned bytes without trusting wrappers or signatures', () => {
    const input = hex(vector.publicKey);
    const first = ok(Bytes.signingPublicKey(input));
    const second = ok(Bytes.signingPublicKey(input));
    expect(second).not.toBe(first);
    second.toBytes().fill(0);
    expect(first.toBytes()).toEqual(hex(vector.publicKey));
    expect(ok(verifySignature(input, new Uint8Array(), rfcSig))).toBeUndefined();

    const other = Point.BASE.multiply(2n).toBytes();
    input.set(other);
    expect(ok(Bytes.signingPublicKey(input)).toBytes()).toEqual(other);
    expect(Result.isFailure(verifySignature(input, new Uint8Array(), rfcSig))).toBe(true);
    input.set(hex(vector.publicKey));
    expect(ok(verifySignature(input, new Uint8Array(), rfcSig))).toBeUndefined();
    expect(Result.isFailure(verifySignature(input, new Uint8Array([1]), rfcSig))).toBe(true);

    const Constructor = Object.getPrototypeOf(first).constructor as new (
      kind: string,
      bytes: Uint8Array
    ) => Bytes.SigningPublicKey;
    const torsion = hex('ec' + 'ff'.repeat(30) + '7f');
    const mixed = Point.fromBytes(first.toBytes(), false)
      .add(Point.fromBytes(torsion, false))
      .toBytes();
    for (const bytes of [
      hex('01' + '00'.repeat(31)),
      new Uint8Array(32),
      new Uint8Array(32).fill(255),
      mixed,
    ]) {
      const forged = new Constructor('SigningPublicKey', bytes);
      expect(Result.isFailure(Bytes.signingPublicKey(forged))).toBe(true);
      expect(Result.isFailure(verifySignature(forged, new Uint8Array(), rfcSig))).toBe(true);
      input.set(forged.toBytes());
      expect(Result.isFailure(Bytes.signingPublicKey(input))).toBe(true);
      expect(Result.isFailure(verifySignature(input, new Uint8Array(), rfcSig))).toBe(true);
    }
    // Churn beyond the retained key budget, then reuse and mutate the original input.
    for (let scalar = 3n; scalar < 261n; scalar++)
      ok(Bytes.signingPublicKey(Point.BASE.multiply(scalar).toBytes()));
    input.set(hex(vector.publicKey));
    expect(ok(verifySignature(input, new Uint8Array(), rfcSig))).toBeUndefined();
    input.fill(0);
    expect(Result.isFailure(verifySignature(input, new Uint8Array(), rfcSig))).toBe(true);
    expect(first.toBytes()).toEqual(hex(vector.publicKey));
  });
  it('accepts the RFC vector through Result and existing Effect', async () => {
    expect(ok(verifySignature(key.toBytes(), new Uint8Array(), rfcSig))).toBeUndefined();
    await Effect.runPromise(
      Effect.fromResult(verifySignature(key.toBytes(), new Uint8Array(), rfcSig))
    );
    expect(Result.isFailure(verifySignature(key.toBytes(), new Uint8Array([1]), rfcSig))).toBe(
      true
    );
  });
  it('rejects identity, noncanonical and mixed-torsion public keys and R', () => {
    const torsion = hex('ec' + 'ff'.repeat(30) + '7f');
    const mixed = Point.fromBytes(key.toBytes(), false)
      .add(Point.fromBytes(torsion, false))
      .toBytes();
    for (const pk of [
      hex('01' + '00'.repeat(31)),
      new Uint8Array(32),
      new Uint8Array(32).fill(255),
      mixed,
    ]) {
      expect(Result.isFailure(Bytes.signingPublicKey(pk))).toBe(true);
      expect(Result.isFailure(verifySignature(pk, new Uint8Array(), rfcSig))).toBe(true);
    }
    const sig = rfcSig.slice();
    sig.set(
      Point.fromBytes(sig.subarray(0, 32), false).add(Point.fromBytes(torsion, false)).toBytes()
    );
    expect(Result.isFailure(verifySignature(key.toBytes(), new Uint8Array(), sig))).toBe(true);
  });
  it('rejects noncanonical S and incorrect signature lengths', () => {
    const sig = rfcSig.slice();
    sig.fill(255, 32);
    for (const s of [sig, rfcSig.slice(1), new Uint8Array(65)])
      expect(Result.isFailure(verifySignature(key.toBytes(), new Uint8Array(), s))).toBe(true);
  });
});

describe('fixed native Ed25519 verification', () => {
  const privateKey = createPrivateKey({
    format: 'der',
    type: 'pkcs8',
    key: Buffer.from(
      '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
      'hex'
    ),
  });
  const native = (pk: unknown, message: Uint8Array, sig: unknown) =>
    Effect.runPromise(Effect.result(verifySignatureEffect(pk, message, sig)));
  it('agrees with the strict synchronous verifier on RFC/native signatures and malformed tuples', async () => {
    const pk = key.toBytes(),
      message = Uint8Array.of(173, 1, 2),
      sig = new Uint8Array(sign(null, message, privateKey));
    for (const [data, signed] of [
      [new Uint8Array(), rfcSig],
      [message, sig],
    ] as const) {
      expect(Result.isSuccess(verifySignature(pk, data, signed))).toBe(true);
      expect(Result.isSuccess(await native(pk, data, signed))).toBe(true);
    }
    const torsion = Point.fromBytes(hex('ec' + 'ff'.repeat(30) + '7f'), false);
    const mixedKey = Point.fromBytes(pk, false).add(torsion).toBytes();
    const mixedR = sig.slice();
    mixedR.set(Point.fromBytes(sig.subarray(0, 32), false).add(torsion).toBytes());
    const noncanonicalR = sig.slice();
    noncanonicalR.fill(255, 0, 32);
    const scalar = sig.slice();
    scalar.fill(255, 32);
    const malformed = [
      [pk, Uint8Array.of(173, 1, 3), sig],
      [Point.BASE.toBytes(), message, sig],
      [hex('01' + '00'.repeat(31)), message, sig],
      [new Uint8Array(32), message, sig],
      [new Uint8Array(32).fill(255), message, sig],
      [mixedKey, message, sig],
      [pk, message, mixedR],
      [pk, message, noncanonicalR],
      [pk, message, scalar],
      [pk, message, sig.slice(1)],
      [pk, message, new Uint8Array(65)],
    ] as const;
    for (const [publicKey, data, signed] of malformed) {
      const expected = verifySignature(publicKey, data, signed),
        actual = await native(publicKey, data, signed);
      expect(Result.isFailure(expected)).toBe(true);
      expect(Result.isFailure(actual) && actual.failure.code).toBe(
        Result.isFailure(expected) && expected.failure.code
      );
    }
  });
  it('owns all inputs before awaiting native import, reuses exact successes and rejects changed messages', async () => {
    const pk = key.toBytes(),
      message = Uint8Array.of(173, 2, 3),
      sig = new Uint8Array(sign(null, message, privateKey));
    const original = { pk: pk.slice(), message: message.slice(), sig: sig.slice() };
    const subtle = globalThis.crypto.subtle,
      importKey = subtle.importKey.bind(subtle);
    let entered!: () => void, release!: () => void, scratch: Uint8Array | undefined;
    const arrived = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const spy = vi.spyOn(subtle, 'importKey').mockImplementation(async (...args) => {
      scratch = args[1] as Uint8Array;
      entered();
      await gate;
      return importKey(...args);
    });
    try {
      const work = native(pk, message, sig);
      await arrived;
      pk.fill(0);
      message.fill(0);
      sig.fill(0);
      expect(scratch).toEqual(original.pk);
      release();
      expect(Result.isSuccess(await work)).toBe(true);
      expect(scratch).toEqual(new Uint8Array(32));
      expect(Result.isSuccess(verifySignature(original.pk, original.message, original.sig))).toBe(
        true
      );
      expect(
        Result.isFailure(verifySignature(original.pk, Uint8Array.of(173, 2, 4), original.sig))
      ).toBe(true);
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it('awaits an interrupted native verify and clears owned scratch after actual settlement', async () => {
    const pk = key.toBytes(),
      message = Uint8Array.of(173, 3, 4),
      sig = new Uint8Array(sign(null, message, privateKey));
    const subtle = globalThis.crypto.subtle,
      verifyNative = subtle.verify.bind(subtle);
    let scratchMessage: Uint8Array | undefined, scratchSignature: Uint8Array | undefined;
    let entered!: () => void, release!: () => void;
    const arrived = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const spy = vi.spyOn(subtle, 'verify').mockImplementation(async (...args) => {
      scratchSignature = args[2] as Uint8Array;
      scratchMessage = args[3] as Uint8Array;
      entered();
      await gate;
      return verifyNative(...args);
    });
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* Effect.forkChild(verifySignatureEffect(pk, message, sig));
            yield* Effect.promise(() => arrived);
            worker.interruptUnsafe();
            expect(worker.pollUnsafe()).toBeUndefined();
            expect(scratchMessage).toEqual(message);
            expect(scratchSignature).toEqual(sig);
            release();
            const exit = yield* Fiber.await(worker);
            expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
            expect(scratchMessage).toEqual(new Uint8Array(message.length));
            expect(scratchSignature).toEqual(new Uint8Array(64));
          })
        )
      );
      expect(message).toEqual(Uint8Array.of(173, 3, 4));
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it('separates backend failure from bad signatures and clears failed import scratch', async () => {
    const message = Uint8Array.of(173, 4, 5),
      sig = new Uint8Array(sign(null, message, privateKey));
    let scratch: Uint8Array | undefined;
    const spy = vi
      .spyOn(globalThis.crypto.subtle, 'importKey')
      .mockImplementation(async (...args) => {
        scratch = args[1] as Uint8Array;
        throw new Error('synthetic native unavailable');
      });
    try {
      const result = await native(key.toBytes(), message, sig);
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        _tag: 'NativeSignatureError',
        code: 'native-unavailable',
      });
      expect(scratch).toEqual(new Uint8Array(32));
      expect(Result.isSuccess(verifySignature(key.toBytes(), message, sig))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
  it('preserves native-unavailable when checking a borrowed signer result', async () => {
    const message = Uint8Array.of(173, 6, 7);
    const signer = {
      publicKey: key,
      sign: (data: Uint8Array) =>
        Effect.sync(() => ok(Bytes.signature(new Uint8Array(sign(null, data, privateKey))))),
    };
    const spy = vi
      .spyOn(globalThis.crypto.subtle, 'importKey')
      .mockRejectedValue(new Error('synthetic native unavailable'));
    try {
      const result = await Effect.runPromise(Effect.result(signVerified(signer, message)));
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        _tag: 'ContentError',
        code: 'native-unavailable',
      });
    } finally {
      spy.mockRestore();
    }
  });
  it('bounds successful tuples and does not retain messages above 8192 bytes', async () => {
    const pk = key.toBytes(),
      original = Uint8Array.of(173, 5, 0),
      originalSig = new Uint8Array(sign(null, original, privateKey));
    expect(Result.isSuccess(await native(pk, original, originalSig))).toBe(true);
    for (let i = 0; i < 257; i++) {
      const message = Uint8Array.of(174, i >>> 8, i & 255),
        signed = new Uint8Array(sign(null, message, privateKey));
      expect(Result.isSuccess(await native(pk, message, signed))).toBe(true);
    }
    const big = new Uint8Array(8193).fill(175),
      bigSig = new Uint8Array(sign(null, big, privateKey));
    expect(Result.isSuccess(await native(pk, big, bigSig))).toBe(true);
    const limit = new Uint8Array(8192).fill(176),
      limitSig = new Uint8Array(sign(null, limit, privateKey));
    expect(Result.isSuccess(await native(pk, limit, limitSig))).toBe(true);
    const spy = vi
      .spyOn(globalThis.crypto.subtle, 'importKey')
      .mockRejectedValue(new Error('synthetic native unavailable'));
    try {
      expect(Result.isSuccess(await native(pk, limit, limitSig))).toBe(true);
      for (const [message, signed] of [
        [original, originalSig],
        [big, bigSig],
      ] as const) {
        const result = await native(pk, message, signed);
        expect(Result.isFailure(result) && result.failure.code).toBe('native-unavailable');
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe('v0 content context and signature', () => {
  it('matches fixed context and native-signed frame bytes', () => {
    expect(toHex(ok(encodeContentContext(scope)))).toBe(vector.context);
    expect(toHex(ok(encodeDocumentContext(scope)))).toBe(vector.context.slice(0, -2));
    expect(ok(encodeContentHeader({ ...scope, docEpoch: 0, device: vector.publicKey }))).toEqual(
      frame().subarray(0, 39)
    );
    const bytes = frame();
    const signing = ok(contentSigningBytes(scope, bytes.subarray(0, -64)));
    const native = createPublicKey({
      key: Buffer.from('302a300506032b6570032100' + vector.publicKey, 'hex'),
      format: 'der',
      type: 'spki',
    });
    expect(verify(null, signing, native, bytes.subarray(-64))).toBe(true);
    expect(ok(verifyContentSignature(bytes, scope, key))).toEqual({
      version: 0,
      docEpoch: 0,
      epoch: scope.epoch,
      device: vector.publicKey,
    });
  });
  it('shares document key info but separates purpose in AAD and signatures', () => {
    for (const purpose of [
      'doc-update',
      'doc-snapshot',
      'flock-update',
      'flock-snapshot',
    ] as const) {
      expect(ok(contentKeyInfo({ ...scope, purpose }))).toEqual(ok(contentKeyInfo(scope)));
      if (purpose !== scope.purpose)
        expect(ok(contentAad({ ...scope, purpose }, new Uint8Array()))).not.toEqual(
          ok(contentAad(scope, new Uint8Array()))
        );
    }
    expect(toHex(ok(contentKeyInfo(scope)))).toBe(
      toHex(new TextEncoder().encode('lody-document-key/v0\0')) + vector.context.slice(0, -2)
    );
    contentHkdfSalt().fill(0);
    expect(new TextDecoder().decode(contentHkdfSalt())).toBe('lody-content-hkdf/v0\0');
  });
  it.each([
    { genesis: '12'.repeat(32) },
    { resource: 'other' },
    { epoch: 2 },
    { purpose: 'doc-snapshot' as ContentPurpose },
    { purpose: 'rpc-request' as ContentPurpose },
  ])('rejects substituted trusted context %j', (change) => {
    expect(Result.isFailure(verifyContentSignature(frame(), { ...scope, ...change }, key))).toBe(
      true
    );
  });
  it('rejects a substituted signer and tampered payload/signature', () => {
    const other = ok(Bytes.signingPublicKey(Point.BASE.toBytes()));
    expect(Result.isFailure(verifyContentSignature(frame(), scope, other))).toBe(true);
    for (const offset of [7, 39, 63, 79, 142]) {
      const bytes = frame();
      bytes[offset] ^= 1;
      expect(Result.isFailure(verifyContentSignature(bytes, scope, key))).toBe(true);
    }
  });
  it('authenticates the independent binding and cannot retry as unbound', () => {
    const bytes = hex(vector.boundFrame);
    expect(Result.isSuccess(verifyContentSignature(bytes, scope, key, hex('abcd')))).toBe(true);
    for (const binding of [undefined, hex('abce'), new Uint8Array(1025)])
      expect(Result.isFailure(verifyContentSignature(bytes, scope, key, binding))).toBe(true);
    expect(Result.isFailure(verifyContentSignature(frame(), scope, key, hex('abcd')))).toBe(true);
  });
  it.each([1, 2, 255])('rejects unsupported content version %s', (version) => {
    const bytes = frame();
    bytes[0] = version;
    expect(Result.isFailure(inspectContentFrame(bytes))).toBe(true);
  });
  it('rejects nonzero docEpoch, truncation, trailing bytes and invalid context encodings', () => {
    const bytes = frame();
    bytes[6] = 1;
    expect(Result.isFailure(inspectContentFrame(bytes))).toBe(true);
    expect(Result.isFailure(inspectContentFrame(frame().subarray(1)))).toBe(true);
    expect(
      Result.isFailure(verifyContentSignature(new Uint8Array([...frame(), 0]), scope, key))
    ).toBe(true);
    for (const change of [
      { genesis: 'AA'.repeat(32) },
      { epoch: -1 },
      { docEpoch: 1 },
      { resource: 'a b' },
      { resource: '文' },
      { purpose: 'unknown' },
    ])
      expect(Result.isFailure(encodeContentContext({ ...scope, ...change } as ContentScope))).toBe(
        true
      );
  });
});

it('agrees across backends on strict Ed25519 subgroup-edge vectors', async () => {
  const { utils } = await import('@noble/ed25519');
  const { sha512 } = await import('@noble/hashes/sha2.js');
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const le = (bytes: Uint8Array) => {
    let n = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
    return n;
  };
  const le32 = (n: bigint) =>
    Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 255n));
  // RFC test seed; synthetic signing only inside this regression fixture.
  const ext = utils.getExtendedPublicKey(
    hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
  );
  const torsion = Point.fromBytes(hex('ec' + 'ff'.repeat(30) + '7f'), false);
  const message = new Uint8Array([4, 5]);
  const r = le(sha512(new Uint8Array([...ext.prefix, ...message]))) % L;
  const vectors: { name: string; A: Uint8Array; sig: Uint8Array; accepted: boolean }[] = [];
  for (const shift of ['neither', 'A', 'R']) {
    const A = shift === 'A' ? ext.point.add(torsion).toBytes() : ext.pointBytes;
    const R =
      shift === 'R'
        ? Point.BASE.multiply(r).add(torsion).toBytes()
        : Point.BASE.multiply(r).toBytes();
    const k = le(sha512(new Uint8Array([...R, ...A, ...message]))) % L;
    const sig = new Uint8Array([...R, ...le32((r + k * ext.scalar) % L)]);
    // Establish the cofactored equation directly; noble's verify policy is
    // independent of the strict public verifier under test.
    const S = le(sig.subarray(32));
    const left = Point.BASE.multiply(S).multiply(8n);
    const right = Point.fromBytes(R, false).add(Point.fromBytes(A, false).multiply(k)).multiply(8n);
    expect(left.equals(right)).toBe(true);
    vectors.push({ name: `torsion shift ${shift}`, A, sig, accepted: shift === 'neither' });
  }
  // r=0 gives a valid prime-subgroup equation, but native providers disagree on
  // this identity R. Both public paths must reject it before native verification.
  const R = Point.ZERO.toBytes(),
    k = le(sha512(new Uint8Array([...R, ...ext.pointBytes, ...message]))) % L;
  const zeroNonceSignature = new Uint8Array([...R, ...le32((k * ext.scalar) % L)]);
  expect(
    Point.BASE.multiply(le(zeroNonceSignature.subarray(32))).equals(ext.point.multiply(k))
  ).toBe(true);
  vectors.push({ name: 'identity R', A: ext.pointBytes, sig: zeroNonceSignature, accepted: false });
  // Identity A can satisfy the equation without a signing secret; key validation
  // rejects it independently of the provider's policy.
  vectors.push({
    name: 'identity A',
    A: Point.ZERO.toBytes(),
    sig: new Uint8Array([...Point.BASE.multiply(r).toBytes(), ...le32(r)]),
    accepted: false,
  });
  const noncanonicalScalar = vectors[0]!.sig.slice();
  noncanonicalScalar.set(le32(L), 32);
  vectors.push({
    name: 'noncanonical S',
    A: ext.pointBytes,
    sig: noncanonicalScalar,
    accepted: false,
  });
  const noncanonicalR = vectors[0]!.sig.slice();
  noncanonicalR.fill(255, 0, 32);
  vectors.push(
    { name: 'noncanonical R', A: ext.pointBytes, sig: noncanonicalR, accepted: false },
    {
      name: 'noncanonical A',
      A: new Uint8Array(32).fill(255),
      sig: vectors[0]!.sig,
      accepted: false,
    }
  );
  for (const edgeVector of vectors) {
    const pure = verifySignature(edgeVector.A, message, edgeVector.sig),
      native = await Effect.runPromise(
        Effect.result(verifySignatureEffect(edgeVector.A, message, edgeVector.sig))
      );
    expect(Result.isSuccess(pure), edgeVector.name).toBe(edgeVector.accepted);
    expect(Result.isSuccess(native), edgeVector.name).toBe(edgeVector.accepted);
    if (Result.isFailure(pure))
      expect(Result.isFailure(native) && native.failure.code, edgeVector.name).toBe(
        pure.failure.code
      );
  }
});
