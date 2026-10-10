import { describe, expect, it } from 'vitest';
import { Effect, Result } from 'effect';
import { Point } from '@noble/ed25519';
import { createPublicKey, verify } from 'node:crypto';
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
} from '../src/index';
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
});

describe('strict Ed25519', () => {
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

it('rejects mixed-torsion A and R even when the cofactored equation accepts them', async () => {
  const { utils, verify: cofactoredVerify } = await import('@noble/ed25519');
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
  for (const shift of ['A', 'R']) {
    const A = shift === 'A' ? ext.point.add(torsion).toBytes() : ext.pointBytes;
    const R =
      shift === 'R'
        ? Point.BASE.multiply(r).add(torsion).toBytes()
        : Point.BASE.multiply(r).toBytes();
    const k = le(sha512(new Uint8Array([...R, ...A, ...message]))) % L;
    const sig = new Uint8Array([...R, ...le32((r + k * ext.scalar) % L)]);
    expect(cofactoredVerify(sig, message, A, { zip215: false })).toBe(true);
    expect(Result.isFailure(verifySignature(A, message, sig))).toBe(true);
  }
});
