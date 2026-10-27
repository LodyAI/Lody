import { hkdfSync, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cause, Deferred, Effect, Exit, Fiber, Result, Scope } from 'effect';
import * as Documents from '@lody/e2ee-core/protocol';
import {
  admitStreamsUpdateBatch,
  admitStreamsUpdateBatchEffect,
  admitStreamsSnapshot,
  admitStreamsSnapshotEffect,
  authenticateStreamsSnapshotEffect,
} from '@lody/e2ee-core/host';
import { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import type { PayloadProtectionProvider } from '@loro-dev/streams-crdt';
import * as Signing from '@lody/e2ee-core/protocol';
import * as Ledger from '@lody/e2ee-core/protocol';
import * as Snapshots from '@lody/e2ee-core/protocol';
import { encodeCbor, type CborValue } from '../src/internal/foundation/cbor';
import {
  Bytes,
  deriveContentKey,
  disposeContentKey,
  sealContentAead,
  openContentAead,
  contentKeyInfo,
  contentHkdfSalt,
  contentAad,
  encodeContentHeader,
  contentSigningBytes,
  inspectContentFrame,
  verifyContentSignature,
  type ContentHeader,
  type ContentKey,
  type ContentScope,
} from '@lody/e2ee-core/protocol';
import vectors from './crypto-vector.json';
import epochVector from './epoch-history-vector.json';
import * as EpochKeys from '@lody/e2ee-core/protocol';
import { copyEpochKeyBytes, disposeEpochKey } from '../src/internal/foundation/epoch-key';

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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
      const scope = {
        ...header,
        purpose: vector.purpose as ContentScope['purpose'],
        ...('continuationOffset' in vector
          ? { continuationOffset: vector.continuationOffset }
          : {}),
      };
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
      const scope = {
        ...header,
        purpose,
        ...(purpose.endsWith('snapshot') ? { continuationOffset: 'opaque:0_123' } : {}),
      };
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
        Result.isSuccess(
          sealContentAead(
            shared,
            {
              ...header,
              purpose,
              ...(purpose.endsWith('snapshot') ? { continuationOffset: 'opaque:0_123' } : {}),
            },
            new Uint8Array()
          )
        )
      ).toBe(true);
  });

  it('supports the full ASCII u16 snapshot field and rejects missing, malformed or update-only fields', () => {
    fixedRandom();
    const snapshot: ContentHeader = {
      ...header,
      purpose: 'doc-snapshot',
      continuationOffset: 'x'.repeat(65535),
    };
    const prefix = read(encodeContentHeader(snapshot));
    expect(prefix.length).toBe(39 + 2 + 65535);
    expect(prefix.subarray(39, 41)).toEqual(new Uint8Array([255, 255]));
    const key = keyFor(snapshot),
      plaintext = new Uint8Array([5, 6]);
    const sealed = read(sealContentAead(key, snapshot, plaintext));
    expect(read(openContentAead(key, snapshot, sealed.nonce, sealed.ciphertext))).toEqual(
      plaintext
    );
    const frame = new Uint8Array(
      Buffer.concat([prefix, sealed.nonce, sealed.ciphertext, new Uint8Array(64)])
    );
    expect(read(inspectContentFrame(frame, 'doc-snapshot')).continuationOffset).toBe(
      snapshot.continuationOffset
    );
    for (const at of [39, 40, 41]) {
      const changed = new Uint8Array(frame);
      if (at === 41) changed[at] = 128;
      else {
        changed[39] = 0;
        changed[40] = 0;
      }
      expect(code(inspectContentFrame(changed, 'doc-snapshot'))).toBe('invalid-snapshot-offset');
    }
    expect(Result.isFailure(inspectContentFrame(frame.subarray(0, -3), 'doc-snapshot'))).toBe(true);
    for (const continuationOffset of [undefined, '', 'x'.repeat(65536), 'é', 'now', '-1', 'x y'])
      expect(code(encodeContentHeader({ ...snapshot, continuationOffset }))).toBe(
        'invalid-snapshot-offset'
      );
    expect(code(encodeContentHeader({ ...header, continuationOffset: 'opaque' }))).toBe(
      'invalid-snapshot-offset'
    );
  });

  it('rejects wrong context even with freshly derived keys and authenticates the trusted signer header', () => {
    fixedRandom();
    const sealed = read(sealContentAead(keyFor(), header, new Uint8Array([1, 2, 3])));
    const alternatives: ContentHeader[] = [
      { ...header, genesis: '12'.repeat(32) },
      { ...header, epoch: 5 },
      { ...header, resource: 'other' },
      { ...header, purpose: 'doc-snapshot', continuationOffset: 'opaque:0_123' },
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

describe('operation-owned document leaf resources', () => {
  it('derives only on execution and captures the requested scope', async () => {
    const epoch = read(Bytes.epochKey(source));
    const scope = { ...header };
    const acquire = Documents.scopedDocumentKey(scope, epoch);
    scope.resource = 'changed-after-construction';
    const expected = read(Documents.deriveDocumentKey(header, epoch));
    const actual = await Effect.runPromise(
      Effect.scoped(
        acquire.pipe(Effect.flatMap((key) => Effect.fromResult(Documents.exportDocumentKey(key))))
      )
    );
    expect(actual).toEqual(read(Documents.exportDocumentKey(expected)));
    Documents.disposeDocumentKey(expected);

    const unused = Documents.scopedDocumentKey(header, epoch);
    disposeEpochKey(epoch);
    const failed = await Effect.runPromise(Effect.result(Effect.scoped(unused)));
    expect(Result.isFailure(failed)).toBe(true);
  });

  it('invalidates a closed leaf while retaining independently owned sibling and borrowed epoch', async () => {
    const epoch = read(Bytes.epochKey(source));
    const sibling = read(Documents.deriveDocumentKey(header, epoch));
    const retained = await Effect.runPromise(
      Effect.scoped(
        Documents.scopedDocumentKey(header, epoch).pipe(
          Effect.map((key) => {
            expect(read(Documents.exportDocumentKey(key))).toEqual(
              read(Documents.exportDocumentKey(sibling))
            );
            return key;
          })
        )
      )
    );
    expect(code(Documents.exportDocumentKey(retained))).toBe('invalid-document-key');
    Documents.disposeDocumentKey(retained);
    expect(read(Documents.exportDocumentKey(sibling))).toHaveLength(32);
    const another = read(Documents.deriveDocumentKey(header, epoch));
    expect(read(Documents.exportDocumentKey(another))).toEqual(
      read(Documents.exportDocumentKey(sibling))
    );
    Documents.disposeDocumentKey(sibling);
    Documents.disposeDocumentKey(another);
    disposeEpochKey(epoch);
  });
});

describe('ledger-bound signed document workflows', () => {
  function identity(seed: number) {
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.alloc(32, seed),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const raw = new Uint8Array(
      createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
    );
    const publicKey = read(Bytes.signingPublicKey(raw));
    const signBytes = (message: Uint8Array) => new Uint8Array(sign(null, message, privateKey));
    const signer: Signing.DeviceSigner = {
      publicKey,
      sign: (message) => Effect.succeed(read(Bytes.signature(signBytes(message)))),
    };
    return { privateKey, raw, publicKey, signBytes, signer };
  }
  function ledgerFixture(realCommitment = false) {
    const owner = identity(1),
      phone = identity(2),
      attacker = identity(3);
    const tag = (name: string, payload: Uint8Array) =>
      new Uint8Array(Buffer.concat([Buffer.from(`lody-e2ee/${name}\0`), payload]));
    const record = (body: readonly CborValue[]) =>
      read(encodeCbor([body, owner.signBytes(tag('sig/v1', read(encodeCbor(body))))]));
    const rows = [
      record([
        1,
        owner.raw,
        new Uint8Array(32).fill(10),
        new Uint8Array(16).fill(10),
        new Uint8Array(32).fill(100),
        realCommitment
          ? read(
              EpochKeys.commitEpochKey(
                read(Bytes.genesisHash(new Uint8Array(32))),
                0,
                read(Bytes.epochKey(source))
              )
            ).toBytes()
          : new Uint8Array(32).fill(20),
      ]),
    ];
    const anchor = read(Bytes.genesisHash(Ledger.hashRecordBytes(rows[0]!).toBytes()));
    const view = () =>
      read(
        Ledger.verifyLedger({
          anchor,
          records: rows,
          checkpoint: { head: Ledger.hashRecordBytes(rows.at(-1)!), length: rows.length },
        })
      );
    const append = (op: readonly CborValue[]) =>
      rows.push(record([Ledger.hashRecordBytes(rows.at(-1)!).toBytes(), owner.raw, op]));
    const addPhone = () => {
      const enc = new Uint8Array(32).fill(102);
      const proof = phone.signBytes(
        tag(
          'possess/v2',
          read(encodeCbor([anchor.toBytes(), new Uint8Array(16).fill(10), phone.raw, enc, 0]))
        )
      );
      append([4, 0, phone.raw, enc, proof]);
    };
    const scope: ContentScope = {
      genesis: hex(anchor.toBytes()),
      epoch: 0,
      resource: 'doc',
      purpose: 'doc-update',
    };
    const key = read(Documents.deriveDocumentKey(scope, read(Bytes.epochKey(source))));
    const publishEpoch = (secret: Uint8Array) => {
      const previousKey = read(Bytes.epochKey(source));
      const currentKey = read(Bytes.epochKey(secret));
      try {
        append([
          7,
          1,
          read(EpochKeys.commitEpochKey(anchor, 1, currentKey)).toBytes(),
          read(EpochKeys.sealHistoryPacket({ genesis: anchor, epoch: 1, currentKey, previousKey })),
        ]);
      } finally {
        disposeEpochKey(previousKey);
        disposeEpochKey(currentKey);
      }
    };
    return { owner, phone, attacker, scope, key, view, append, addPhone, publishEpoch };
  }
  const result = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));
  const updateContext = {
    protocol: 'loro-streams-crdt-payload-protection',
    version: 2,
    kind: 'update_batch',
  } as const;
  const updateInput = {
    context: updateContext,
    plaintext: new Uint8Array([8, 9]),
    additionalData: () => new Uint8Array([1, 2]),
  };
  const bindingOptions = (f: ReturnType<typeof ledgerFixture>) => ({
    genesis: f.view().genesis,
    resource: f.scope.resource,
    model: 'loro' as const,
    writeEpoch: 0,
    signer: f.owner.signer,
    ledger: () => Effect.succeed(f.view()),
    readEpochKey: () => Effect.sync(() => read(Bytes.epochKey(source))),
  });
  it('admits exact header3 SDK batches only for the current authenticated writer, refusing whole mixed batches before forwarding', async () => {
    const f = ledgerFixture(true);
    f.addPhone();
    const prefix = new Uint8Array([76, 83, 67, 69, 2, 1, 0, 1, 0, 0, 3]);
    const domain = new TextEncoder().encode('loro-streams-crdt-payload-protection/v2\0');
    const additionalData = new Uint8Array(domain.length + prefix.length);
    additionalData.set(domain);
    additionalData.set(prefix, domain.length);
    const body = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const binding = yield* makeStreamsUpdateBinding({
            ...bindingOptions(f),
            signer: f.phone.signer,
          });
          const sealed = yield* binding.seal({
            context: updateContext,
            plaintext: new Uint8Array([4, 5]),
            additionalData: () => additionalData,
          });
          const frame = new Uint8Array(4 + prefix.length + sealed.sealed.length);
          new DataView(frame.buffer).setUint32(0, prefix.length + sealed.sealed.length, false);
          frame.set(prefix, 4);
          frame.set(sealed.sealed, 4 + prefix.length);
          return frame;
        })
      )
    );
    const options = {
      genesis: f.view().genesis,
      resource: f.scope.resource,
      model: 'loro' as const,
      view: f.view(),
      device: f.phone.signer.publicKey,
      body,
    };
    const admitted = read(admitStreamsUpdateBatch(options));
    expect(await Effect.runPromise(admitStreamsUpdateBatchEffect(options))).toEqual(admitted);
    expect(admitted).toEqual(body);
    expect(admitted).not.toBe(body);
    expect(
      Result.isFailure(admitStreamsUpdateBatch({ ...options, device: f.owner.signer.publicKey }))
    ).toBe(true);
    expect(
      Result.isFailure(admitStreamsUpdateBatch({ ...options, resource: 'another document' }))
    ).toBe(true);
    expect(Result.isFailure(admitStreamsUpdateBatch({ ...options, model: 'flock' }))).toBe(true);
    expect(
      Result.isFailure(
        admitStreamsUpdateBatch({
          ...options,
          genesis: read(Bytes.genesisHash(new Uint8Array(32).fill(91))),
        })
      )
    ).toBe(true);
    expect(
      Result.isFailure(admitStreamsUpdateBatch({ ...options, view: { ...options.view } }))
    ).toBe(true);
    for (const position of [body.length - 1, 4 + 4, 4 + 5, 4 + 8, 4 + 10]) {
      const invalid = new Uint8Array(body);
      invalid[position] = invalid[position]! ^ 1;
      expect(Result.isFailure(admitStreamsUpdateBatch({ ...options, body: invalid }))).toBe(true);
      const mixed = new Uint8Array(body.length * 2);
      mixed.set(body);
      mixed.set(invalid, body.length);
      expect(Result.isFailure(admitStreamsUpdateBatch({ ...options, body: mixed }))).toBe(true);
    }
    expect(Result.isFailure(admitStreamsUpdateBatch({ ...options, body: new Uint8Array() }))).toBe(
      true
    );
    expect(
      Result.isFailure(
        admitStreamsUpdateBatch({ ...options, body: body.subarray(0, body.length - 1) })
      )
    ).toBe(true);
    f.append([5, f.phone.raw]);
    // A legitimately historical author still authenticates old bytes, but cannot
    // use that historical identity for a fresh write through the host API.
    expect(
      Result.isSuccess(
        Documents.authenticateDocument(f.view(), f.scope, body.subarray(15), additionalData)
      )
    ).toBe(true);
    expect(code(admitStreamsUpdateBatch({ ...options, view: f.view() }))).toBe('unauthorized');
  });
  it.each(['tag7', 'tag8', 'rotation-required'] as const)(
    'admits original sealed updates and snapshots after %s while retaining active writer access',
    async (transition) => {
      const f = ledgerFixture(true);
      f.addPhone();
      const removedMembership = new Uint8Array(16).fill(11);
      if (transition === 'tag8') {
        const request = [
          new Uint8Array(16).fill(11),
          new Uint8Array(32).fill(11),
          f.attacker.raw,
          new Uint8Array(32).fill(103),
          null,
        ] as const;
        const message = new Uint8Array(
          Buffer.concat([
            Buffer.from('lody-e2ee/join/v1\0'),
            read(encodeCbor([f.view().genesis.toBytes(), ...request])),
          ])
        );
        f.append([1, removedMembership, [...request, f.attacker.signBytes(message)]]);
      }
      const oldView = f.view();
      const nextSecret = new Uint8Array(32).fill(8);
      const snapshotContext = {
        ...updateContext,
        kind: 'snapshot' as const,
        continuationOffset: '0_123',
      };
      const prefix = (snapshot: boolean) =>
        new Uint8Array([76, 83, 67, 69, 2, snapshot ? 2 : 1, 0, 1, 0, 0, snapshot ? 4 : 3]);
      const aadFor = (snapshot: boolean) =>
        new Uint8Array(
          Buffer.concat([
            Buffer.from('loro-streams-crdt-payload-protection/v2\0'),
            prefix(snapshot),
          ])
        );
      const batch = (frames: readonly Uint8Array[]) =>
        new Uint8Array(
          Buffer.concat(
            frames.map((frame) => {
              const size = new Uint8Array(4);
              new DataView(size.buffer).setUint32(0, prefix(false).length + frame.length, false);
              return Buffer.concat([size, prefix(false), frame]);
            })
          )
        );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const binding = yield* makeStreamsUpdateBinding({
              ...bindingOptions(f),
              writeEpoch: 'current',
              readEpochKey: (epoch) =>
                Effect.sync(() => read(Bytes.epochKey(epoch === 0 ? source : nextSecret))),
            });
            const old = yield* binding.seal({
              ...updateInput,
              additionalData: () => aadFor(false),
            });
            const snapshot = yield* binding.seal({
              ...updateInput,
              context: snapshotContext,
              additionalData: () => aadFor(true),
            });
            const originalUpdate = new Uint8Array(old.sealed);
            const originalSnapshot = new Uint8Array(snapshot.sealed);
            if (transition === 'tag7') f.publishEpoch(nextSecret);
            else if (transition === 'tag8') {
              const previousKey = read(Bytes.epochKey(source));
              const currentKey = read(Bytes.epochKey(nextSecret));
              try {
                f.append([
                  8,
                  removedMembership,
                  1,
                  read(EpochKeys.commitEpochKey(oldView.genesis, 1, currentKey)).toBytes(),
                  read(
                    EpochKeys.sealHistoryPacket({
                      genesis: oldView.genesis,
                      epoch: 1,
                      currentKey,
                      previousKey,
                    })
                  ),
                ]);
              } finally {
                disposeEpochKey(previousKey);
                disposeEpochKey(currentKey);
              }
            } else f.append([5, f.phone.raw]);
            const view = f.view();
            expect(view.inspectState().epoch).toMatchObject(
              transition === 'rotation-required'
                ? { number: 0, rotationRequired: true }
                : { number: 1, rotationRequired: false }
            );
            const input = {
              genesis: view.genesis,
              resource: f.scope.resource,
              model: 'loro' as const,
              view,
              device: f.owner.publicKey,
              body: batch([old.sealed]),
            };
            const direct = Documents.admitDocument(
              view,
              f.scope,
              old.sealed,
              f.owner.publicKey,
              aadFor(false)
            );
            expect(Result.isSuccess(direct)).toBe(true);
            expect(read(direct).header.epoch).toBe(0);
            expect(read(admitStreamsUpdateBatch(input))).toEqual(input.body);
            expect(yield* admitStreamsUpdateBatchEffect(input)).toEqual(input.body);
            const snapshotInput = {
              ...input,
              body: new Uint8Array(Buffer.concat([prefix(true), snapshot.sealed])),
              continuationOffset: snapshotContext.continuationOffset,
            };
            expect(read(admitStreamsSnapshot(snapshotInput))).toEqual(snapshotInput.body);
            expect(yield* admitStreamsSnapshotEffect(snapshotInput)).toEqual(snapshotInput.body);
            const next = yield* Effect.result(
              binding.seal({ ...updateInput, additionalData: () => aadFor(false) })
            );
            expect(Result.isSuccess(next)).toBe(true);
            {
              const mixed = { ...input, body: batch([old.sealed, read(next).sealed]) };
              expect(read(admitStreamsUpdateBatch(mixed))).toEqual(mixed.body);
              expect(yield* admitStreamsUpdateBatchEffect(mixed)).toEqual(mixed.body);
              // Only an actual epoch advance is unknown to the old endpoint.
              if (transition !== 'rotation-required')
                expect(
                  code(
                    admitStreamsUpdateBatch({
                      ...input,
                      view: oldView,
                      body: batch([read(next).sealed]),
                    })
                  )
                ).toBe('unauthorized');
            }
            // A real signature cannot manufacture an unpublished/future epoch.
            const futureScope = { ...f.scope, epoch: 9 };
            const forged = new Uint8Array(old.sealed);
            new DataView(forged.buffer).setUint32(1, futureScope.epoch, false);
            forged.set(
              f.owner.signBytes(
                read(contentSigningBytes(futureScope, forged.subarray(0, -64), aadFor(false)))
              ),
              forged.length - 64
            );
            expect(
              code(
                Documents.admitDocument(view, futureScope, forged, f.owner.publicKey, aadFor(false))
              )
            ).toBe('unauthorized');
            expect(
              code(admitStreamsUpdateBatch({ ...input, body: batch([old.sealed, forged]) }))
            ).toBe('unauthorized');
            expect(
              code(
                yield* Effect.result(
                  admitStreamsUpdateBatchEffect({ ...input, body: batch([old.sealed, forged]) })
                )
              )
            ).toBe('unauthorized');
            const futureSnapshotScope = { ...futureScope, purpose: 'doc-snapshot' as const };
            const futureSnapshot = new Uint8Array(snapshot.sealed);
            new DataView(futureSnapshot.buffer).setUint32(1, futureScope.epoch, false);
            futureSnapshot.set(
              f.owner.signBytes(
                read(
                  contentSigningBytes(
                    futureSnapshotScope,
                    futureSnapshot.subarray(0, -64),
                    aadFor(true)
                  )
                )
              ),
              futureSnapshot.length - 64
            );
            const unknownSnapshot = {
              ...snapshotInput,
              body: new Uint8Array(Buffer.concat([prefix(true), futureSnapshot])),
            };
            expect(code(admitStreamsSnapshot(unknownSnapshot))).toBe('unauthorized');
            expect(code(yield* Effect.result(admitStreamsSnapshotEffect(unknownSnapshot)))).toBe(
              'unauthorized'
            );
            expect(old.sealed).toEqual(originalUpdate);
            expect(snapshot.sealed).toEqual(originalSnapshot);
          })
        )
      );
    }
  );
  it('binds settled header3 updates to real ledger, signer and commitment using published SDK types', async () => {
    const f = ledgerFixture(true);
    let owned: Bytes.EpochKey | undefined;
    const binding = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const value = yield* makeStreamsUpdateBinding({
            ...bindingOptions(f),
            readEpochKey: () =>
              Effect.sync(() => {
                owned = read(Bytes.epochKey(source));
                return owned;
              }),
          });
          // Test-only Promise boundary. Lab composition owns its runner and raw SDK lifetime separately.
          const sdk: PayloadProtectionProvider = {
            maxSealOverheadBytes: value.maxSealOverheadBytes,
            seal: (request) => Effect.runPromise(value.seal(request)),
            open: (request) => Effect.runPromise(value.open(request)),
          };
          const sealed = yield* value.seal(updateInput);
          expect(sealed.header).toEqual(new Uint8Array([3]));
          expect(
            sealed.header.length + sealed.sealed.length - updateInput.plaintext.length
          ).toBeLessThanOrEqual(sdk.maxSealOverheadBytes);
          expect(code(deriveContentKey(owned!, header))).toBe('invalid-content-key');
          const opened = yield* value.open({
            ...sealed,
            context: updateContext,
            additionalData: new Uint8Array([1, 2]),
          });
          expect(opened).toEqual(updateInput.plaintext);
          expect(code(deriveContentKey(owned!, header))).toBe('invalid-content-key');
          return value;
        })
      )
    );
    expect(Result.isFailure(await result(binding.seal(updateInput)))).toBe(true);
  });
  it.each(['loro', 'flock'] as const)(
    'authenticates %s snapshot position inside content v0 and current host admission',
    async (model) => {
      const f = ledgerFixture(true);
      const context = { ...updateContext, kind: 'snapshot' as const, continuationOffset: '0_123' };
      const aadFor = (providerHeader: Uint8Array) => {
        const prefix = new Uint8Array(10 + providerHeader.length);
        prefix.set([76, 83, 67, 69, 2, 2, 0, 0, 0, 0]);
        new DataView(prefix.buffer).setUint16(6, providerHeader.length, false);
        prefix.set(providerHeader, 10);
        const domain = new TextEncoder().encode('loro-streams-crdt-payload-protection/v2\0');
        return new Uint8Array(Buffer.concat([domain, prefix]));
      };
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const binding = yield* makeStreamsUpdateBinding({ ...bindingOptions(f), model });
            const sealed = yield* binding.seal({ ...updateInput, context, additionalData: aadFor });
            expect(sealed.header).toEqual(new Uint8Array([4]));
            expect(sealed.sealed.length - updateInput.plaintext.length).toBe(143 + 2 + 5);
            expect(sealed.sealed.subarray(39, 46)).toEqual(
              new Uint8Array([0, 5, ...new TextEncoder().encode('0_123')])
            );
            const aad = aadFor(sealed.header);
            expect(yield* binding.open({ ...sealed, context, additionalData: aad })).toEqual(
              updateInput.plaintext
            );
            const prefix = aad.subarray(
              new TextEncoder().encode('loro-streams-crdt-payload-protection/v2\0').length
            );
            const body = new Uint8Array(Buffer.concat([prefix, sealed.sealed]));
            const input = {
              genesis: f.view().genesis,
              resource: f.scope.resource,
              model,
              view: f.view(),
              device: f.owner.publicKey,
              body,
              continuationOffset: '0_123',
            };
            expect(read(admitStreamsSnapshot(input))).toEqual(body);
            expect(yield* admitStreamsSnapshotEffect(input)).toEqual(body);
            expect(code(admitStreamsSnapshot({ ...input, continuationOffset: '0_124' }))).toBe(
              'invalid-snapshot-offset'
            );
            expect(
              Result.isFailure(admitStreamsSnapshot({ ...input, device: f.phone.publicKey }))
            ).toBe(true);
            expect(Result.isFailure(admitStreamsSnapshot({ ...input, resource: 'wrong' }))).toBe(
              true
            );
            expect(
              Result.isFailure(
                admitStreamsSnapshot({ ...input, model: model === 'loro' ? 'flock' : 'loro' })
              )
            ).toBe(true);
            expect(
              code(
                yield* Effect.result(
                  binding.open({
                    ...sealed,
                    context: { ...context, continuationOffset: '0_124' },
                    additionalData: aad,
                  })
                )
              )
            ).toBe('invalid-snapshot-offset');
            const oldHeader = new Uint8Array([4, 0, 5, ...new TextEncoder().encode('0_123')]);
            expect(
              Result.isFailure(
                yield* Effect.result(
                  binding.open({ ...sealed, header: oldHeader, context, additionalData: aad })
                )
              )
            ).toBe(true);
            const changedHeader = new Uint8Array(sealed.header);
            changedHeader[changedHeader.length - 1] ^= 1;
            expect(
              Result.isFailure(
                yield* Effect.result(
                  binding.open({
                    ...sealed,
                    header: changedHeader,
                    context: { ...context, continuationOffset: '0_122' },
                    additionalData: aadFor(changedHeader),
                  })
                )
              )
            ).toBe(true);
            const tamperedOffset = new Uint8Array(sealed.sealed);
            tamperedOffset[45] ^= 1;
            expect(
              code(
                yield* Effect.result(
                  binding.open({ ...sealed, sealed: tamperedOffset, context, additionalData: aad })
                )
              )
            ).toBe('bad-content-signature');
            const bad = new Uint8Array(sealed.sealed);
            bad[45] ^= 1;
            const scope = {
              ...f.scope,
              purpose: model === 'loro' ? ('doc-snapshot' as const) : ('flock-snapshot' as const),
            };
            bad.set(
              f.owner.signBytes(read(contentSigningBytes(scope, bad.subarray(0, -64), aad))),
              bad.length - 64
            );
            expect(
              code(
                yield* Effect.result(
                  binding.open({
                    ...sealed,
                    sealed: bad,
                    context: { ...context, continuationOffset: '0_122' },
                    additionalData: aad,
                  })
                )
              )
            ).toBe('content-authentication-failed');
            for (const offset of [
              '',
              'now',
              '-1',
              ' padded',
              'x\n',
              '\ud800',
              'é',
              'x'.repeat(65536),
            ])
              expect(
                code(
                  yield* Effect.result(
                    binding.seal({
                      ...updateInput,
                      context: { ...context, continuationOffset: offset },
                      additionalData: aadFor,
                    })
                  )
                )
              ).toBe('invalid-snapshot-offset');
            f.addPhone();
            f.append([5, f.phone.raw]);
            expect(read(admitStreamsSnapshot({ ...input, view: f.view() }))).toEqual(body);
            const pendingSeal = yield* binding.seal({
              ...updateInput,
              context,
              additionalData: aadFor,
            });
            expect(
              yield* binding.open({
                ...pendingSeal,
                context,
                additionalData: aadFor(pendingSeal.header),
              })
            ).toEqual(updateInput.plaintext);
            expect(yield* authenticateStreamsSnapshotEffect({ ...input, view: f.view() })).toEqual(
              body
            );
            expect(
              Result.isFailure(
                yield* Effect.result(
                  authenticateStreamsSnapshotEffect({
                    ...input,
                    view: f.view(),
                    device: f.phone.publicKey,
                  })
                )
              )
            ).toBe(true);
            expect(yield* binding.open({ ...sealed, context, additionalData: aad })).toEqual(
              updateInput.plaintext
            );
          })
        )
      );
    }
  );
  it('selects each current genuine epoch for new updates while retaining authenticated historical reads', async () => {
    const f = ledgerFixture(true);
    const nextSecret = new Uint8Array(32).fill(8);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const binding = yield* makeStreamsUpdateBinding({
            ...bindingOptions(f),
            writeEpoch: 'current',
            readEpochKey: (epoch) =>
              Effect.sync(() => read(Bytes.epochKey(epoch === 0 ? source : nextSecret))),
          });
          const pinned = yield* makeStreamsUpdateBinding(bindingOptions(f));
          const old = yield* binding.seal(updateInput);
          expect(
            read(
              verifyContentSignature(old.sealed, f.scope, f.owner.publicKey, new Uint8Array([1, 2]))
            ).epoch
          ).toBe(0);
          f.publishEpoch(nextSecret);
          const next = yield* binding.seal(updateInput);
          expect(
            read(
              verifyContentSignature(
                next.sealed,
                { ...f.scope, epoch: 1 },
                f.owner.publicKey,
                new Uint8Array([1, 2])
              )
            ).epoch
          ).toBe(1);
          for (const sealed of [old, next])
            expect(
              yield* binding.open({
                ...sealed,
                context: updateContext,
                additionalData: new Uint8Array([1, 2]),
              })
            ).toEqual(updateInput.plaintext);
          expect(code(yield* Effect.result(pinned.seal(updateInput)))).toBe('unauthorized');
          const missing = yield* makeStreamsUpdateBinding({
            ...bindingOptions(f),
            writeEpoch: 'current',
            readEpochKey: () => Effect.fail('no installed current key'),
          });
          expect(code(yield* Effect.result(missing.seal(updateInput)))).toBe('missing-read-key');
          const forged = yield* makeStreamsUpdateBinding({
            ...bindingOptions(f),
            writeEpoch: 'current',
            ledger: () =>
              Effect.succeed({
                ...f.view(),
                inspectState: () => {
                  throw new Error('unverified view must not be inspected');
                },
              }),
          });
          expect(code(yield* Effect.result(forged.seal(updateInput)))).toBe('unauthorized');
        })
      )
    );
  });
  it('keeps active seals available during manual rotation while refusing revoked writers', async () => {
    const f = ledgerFixture(true);
    f.addPhone();
    const nextSecret = new Uint8Array(32).fill(8);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const options = {
            ...bindingOptions(f),
            writeEpoch: 'current' as const,
            readEpochKey: (epoch: number) =>
              Effect.sync(() => read(Bytes.epochKey(epoch === 0 ? source : nextSecret))),
          };
          const owner = yield* makeStreamsUpdateBinding(options);
          const phone = yield* makeStreamsUpdateBinding({ ...options, signer: f.phone.signer });
          const old = yield* phone.seal(updateInput);
          f.append([5, f.phone.raw]);
          const pending = yield* owner.seal(updateInput);
          expect(
            yield* owner.open({
              ...pending,
              context: updateContext,
              additionalData: new Uint8Array([1, 2]),
            })
          ).toEqual(updateInput.plaintext);
          expect(code(yield* Effect.result(phone.seal(updateInput)))).toBe('unauthorized');
          f.publishEpoch(nextSecret);
          yield* owner.seal(updateInput);
          expect(code(yield* Effect.result(phone.seal(updateInput)))).toBe('unauthorized');
          expect(
            yield* phone.open({
              ...old,
              context: updateContext,
              additionalData: new Uint8Array([1, 2]),
            })
          ).toEqual(updateInput.plaintext);
        })
      )
    );
  });
  it('refuses an epoch change during native signing and clears the operation-owned key before retry', async () => {
    const f = ledgerFixture(true);
    const nextSecret = new Uint8Array(32).fill(8);
    const owned: Bytes.EpochKey[] = [];
    let hold = true;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          const binding = yield* makeStreamsUpdateBinding({
            ...bindingOptions(f),
            writeEpoch: 'current',
            readEpochKey: (epoch) =>
              Effect.sync(() => {
                const key = read(Bytes.epochKey(epoch === 0 ? source : nextSecret));
                owned.push(key);
                return key;
              }),
            signer: {
              publicKey: f.owner.publicKey,
              sign: (message) =>
                Effect.uninterruptible(
                  Effect.gen(function* () {
                    if (hold) {
                      yield* Deferred.succeed(entered, undefined);
                      yield* Deferred.await(release);
                    }
                    return read(Bytes.signature(f.owner.signBytes(message)));
                  })
                ),
            },
          });
          const sealing = yield* Effect.forkChild(Effect.result(binding.seal(updateInput)));
          yield* Deferred.await(entered);
          f.publishEpoch(nextSecret);
          yield* Deferred.succeed(release, undefined);
          expect(code(yield* Fiber.join(sealing))).toBe('unauthorized');
          expect(code(deriveContentKey(owned[0]!, header))).toBe('invalid-content-key');
          hold = false;
          const sealed = yield* binding.seal(updateInput);
          expect(
            read(
              verifyContentSignature(
                sealed.sealed,
                { ...f.scope, epoch: 1 },
                f.owner.publicKey,
                new Uint8Array([1, 2])
              )
            ).epoch
          ).toBe(1);
          expect(code(deriveContentKey(owned[1]!, header))).toBe('invalid-content-key');
        })
      )
    );
  });
  it('waits for an owned in-flight key read before releasing its caller scope, rejects late output and clears the key', async () => {
    const f = ledgerFixture(true);
    let owned: Bytes.EpochKey | undefined;
    let ownerReleased = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.acquireRelease(Scope.make(), (ownedScope) =>
            Scope.close(ownedScope, Exit.void)
          );
          const entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              ownerReleased = true;
            })
          ).pipe(Effect.provideService(Scope.Scope, scope));
          const binding = yield* makeStreamsUpdateBinding({
            ...bindingOptions(f),
            readEpochKey: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                owned = read(Bytes.epochKey(source));
                return owned;
              }),
          }).pipe(Effect.provideService(Scope.Scope, scope));
          const sealing = yield* Effect.forkChild(Effect.result(binding.seal(updateInput)));
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          yield* Deferred.await(entered);
          // Start close synchronously to its explicit in-flight lease wait, before releasing the borrowed read.
          const closing = yield* Effect.sync(() => Effect.runFork(Scope.close(scope, Exit.void)));
          expect(code(yield* Effect.result(binding.seal(updateInput)))).toBe('closed');
          expect(ownerReleased).toBe(false);
          yield* Deferred.succeed(release, undefined);
          const settled = yield* Fiber.join(sealing);
          expect(Result.isFailure(settled)).toBe(true);
          yield* Fiber.join(closing);
          expect(ownerReleased).toBe(true);
          expect(code(deriveContentKey(owned!, header))).toBe('invalid-content-key');
        })
      )
    );
  });
  it('awaits interrupted signing settlement and invalidates its owned epoch on cancellation', async () => {
    const f = ledgerFixture(true);
    let owned: Bytes.EpochKey | undefined;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          const binding = yield* makeStreamsUpdateBinding({
            ...bindingOptions(f),
            readEpochKey: () =>
              Effect.sync(() => {
                owned = read(Bytes.epochKey(source));
                return owned;
              }),
            signer: {
              publicKey: f.owner.publicKey,
              sign: (message) =>
                Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                    return read(Bytes.signature(f.owner.signBytes(message)));
                  })
                ),
            },
          });
          const sealing = yield* Effect.forkChild(binding.seal(updateInput));
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          yield* Deferred.await(entered);
          sealing.interruptUnsafe();
          expect(sealing.pollUnsafe()).toBeUndefined();
          const alive = read(deriveContentKey(owned!, header));
          expect(alive).toBeDefined();
          disposeContentKey(alive);
          yield* Deferred.succeed(release, undefined);
          const exit = yield* Fiber.await(sealing);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          expect(code(deriveContentKey(owned!, header))).toBe('invalid-content-key');
        })
      )
    );
  });
  it('rejects forged authors, wrong key commitments, bad AAD and missing snapshot position', async () => {
    const f = ledgerFixture(true);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const good = yield* makeStreamsUpdateBinding(bindingOptions(f));
          const sealed = yield* good.seal(updateInput);
          const forged = sealed.sealed.slice();
          forged[forged.length - 1] ^= 1;
          const rejectingKey = yield* makeStreamsUpdateBinding({
            ...bindingOptions(f),
            readEpochKey: () => Effect.die('forged frame must not resolve key'),
          });
          expect(
            Result.isFailure(
              yield* Effect.result(
                rejectingKey.open({
                  ...sealed,
                  sealed: forged,
                  context: updateContext,
                  additionalData: new Uint8Array([1, 2]),
                })
              )
            )
          ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(
                good.open({
                  ...sealed,
                  context: updateContext,
                  additionalData: new Uint8Array([2, 1]),
                })
              )
            )
          ).toBe(true);
          const wrong = yield* makeStreamsUpdateBinding({
            ...bindingOptions(f),
            readEpochKey: () => Effect.sync(() => read(Bytes.epochKey(new Uint8Array(32).fill(6)))),
          });
          expect(code(yield* Effect.result(wrong.seal(updateInput)))).toBe('commitment-mismatch');
          expect(
            code(
              yield* Effect.result(
                good.seal({
                  ...updateInput,
                  context: { ...updateContext, kind: 'snapshot', continuationOffset: '' },
                })
              )
            )
          ).toBe('invalid-snapshot-offset');
        })
      )
    );
  });

  it('round-trips native-signed v0 bytes and keeps the scoped document leaf shared across update/snapshot purposes', async () => {
    const f = ledgerFixture(),
      plaintext = new Uint8Array([1, 2, 3]);
    const binding = new Uint8Array([7, 8]);
    const frame = await Effect.runPromise(
      Documents.sealDocument({
        scope: f.scope,
        documentKey: f.key,
        signer: f.owner.signer,
        ledger: () => Effect.succeed(f.view()),
        plaintext,
        additionalData: binding,
      })
    );
    expect(read(verifyContentSignature(frame, f.scope, f.owner.publicKey, binding)).epoch).toBe(0);
    expect(frame.length - plaintext.length).toBe(143);
    const opened = read(Documents.openDocument(f.view(), f.scope, f.key, frame, binding));
    expect(opened.plaintext).toEqual(plaintext);
    expect(opened.author.kind).toBe('member');
    if (opened.author.kind !== 'member') throw new Error('fixture full author');
    expect(hex(opened.author.actor.toBytes())).toBe('0a'.repeat(32));
    const exported = read(Documents.exportDocumentKey(f.key));
    expect(exported).toEqual(nativeKey(f.scope));
    const imported = read(Documents.importDocumentKey(f.scope, exported));
    exported.fill(0);
    expect(
      read(Documents.openDocument(f.view(), f.scope, imported, frame, binding)).plaintext
    ).toEqual(plaintext);
    const snapshot = { ...f.scope, purpose: 'doc-snapshot' as const };
    const snap = await Effect.runPromise(
      Documents.sealDocument({
        scope: snapshot,
        continuationOffset: 'opaque:0_123',
        documentKey: f.key,
        signer: f.owner.signer,
        ledger: () => Effect.succeed(f.view()),
        plaintext,
      })
    );
    expect(snap.length - plaintext.length).toBe(143 + 2 + 'opaque:0_123'.length);
    expect(
      read(Documents.openDocument(f.view(), snapshot, f.key, snap)).header.continuationOffset
    ).toBe('opaque:0_123');
    expect(read(Documents.openDocument(f.view(), snapshot, f.key, snap)).plaintext).toEqual(
      plaintext
    );
    expect(
      Result.isFailure(Documents.openDocument(f.view(), snapshot, f.key, frame, binding))
    ).toBe(true);
    expect(
      Result.isFailure(Documents.openDocument(f.view(), f.scope, f.key, frame, new Uint8Array([9])))
    ).toBe(true);
  });
  it('opens a retired author from an endorsed snapshot as its original member without recovering write permission', async () => {
    const f = ledgerFixture();
    f.addPhone();
    const input = {
      scope: f.scope,
      documentKey: f.key,
      signer: f.phone.signer,
      ledger: () => Effect.succeed(f.view()),
      plaintext: new Uint8Array([4, 5]),
    };
    const frame = await Effect.runPromise(Documents.sealDocument(input));
    f.append([5, f.phone.raw]);
    const full = f.view();
    const produced = await Effect.runPromise(
      Snapshots.signLedgerSnapshot({ signer: f.owner.signer, ledger: () => Effect.succeed(full) })
    );
    const device = full.inspectState().devices.get(hex(f.owner.raw))!;
    const trust: Snapshots.SnapshotTrust = {
      source: 'external-confirmation',
      genesis: full.genesis,
      endorser: f.owner.publicKey,
      head: full.head,
      length: full.length,
      headSignature: produced.headSignature,
      membershipId: device.membershipId,
      role: 'owner',
      kind: 'personal',
    };
    const imported = read(Snapshots.verifyLedgerSnapshot({ snapshot: produced.snapshot, trust }));
    const opened = read(Documents.openDocument(imported, f.scope, f.key, frame));
    expect(opened.plaintext).toEqual(new Uint8Array([4, 5]));
    // The qualified endorsement carries the full device history.
    const original = read(Documents.openDocument(full, f.scope, f.key, frame)).author;
    expect(opened.author.kind).toBe('member');
    expect(opened.author.actor.toBytes()).toEqual(original.actor.toBytes());
    expect(opened.author.memberInstance.toBytes()).toEqual(original.memberInstance.toBytes());
    expect(
      Result.isFailure(
        await result(Documents.sealDocument({ ...input, ledger: () => Effect.succeed(imported) }))
      )
    ).toBe(true);
    const bad = new Uint8Array(frame);
    bad[bad.length - 1] ^= 1;
    expect(Result.isFailure(Documents.authenticateDocument(imported, f.scope, bad))).toBe(true);
  });
  it('captures all sealing bytes before a pending ledger lookup', async () => {
    const f = ledgerFixture(),
      plaintext = new Uint8Array([1, 2]),
      binding = new Uint8Array([7]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          let pause = true;
          const lookup = () =>
            Effect.gen(function* () {
              if (pause) {
                pause = false;
                yield* Deferred.succeed(reached, undefined);
                yield* Deferred.await(release);
              }
              return f.view();
            });
          const worker = yield* Effect.forkChild(
            Documents.sealDocument({
              scope: f.scope,
              documentKey: f.key,
              signer: f.owner.signer,
              plaintext,
              additionalData: binding,
              ledger: lookup,
            })
          );
          yield* Deferred.await(reached);
          plaintext.fill(9);
          binding.fill(8);
          yield* Deferred.succeed(release, undefined);
          const frame = yield* Fiber.join(worker);
          expect(
            read(Documents.openDocument(f.view(), f.scope, f.key, frame, new Uint8Array([7])))
              .plaintext
          ).toEqual(new Uint8Array([1, 2]));
        })
      )
    );
  });
  it('keeps the initial signer, scope and lookup capability when the request object changes while waiting', async () => {
    const f = ledgerFixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          let pause = true;
          const lookup = () =>
            Effect.gen(function* () {
              if (pause) {
                pause = false;
                yield* Deferred.succeed(reached, undefined);
                yield* Deferred.await(release);
              }
              return f.view();
            });
          const request = {
            scope: { ...f.scope },
            documentKey: f.key,
            signer: f.owner.signer,
            plaintext: new Uint8Array([3]),
            ledger: lookup,
          };
          const worker = yield* Effect.forkChild(Documents.sealDocument(request));
          yield* Deferred.await(reached);
          request.scope.resource = 'changed';
          request.signer = f.attacker.signer;
          request.ledger = () => Effect.succeed({ ...f.view() });
          yield* Deferred.succeed(release, undefined);
          const frame = yield* Fiber.join(worker);
          expect(read(verifyContentSignature(frame, f.scope, f.owner.publicKey)).device).toBe(
            hex(f.owner.raw)
          );
          expect(read(Documents.openDocument(f.view(), f.scope, f.key, frame)).plaintext).toEqual(
            new Uint8Array([3])
          );
        })
      )
    );
  });
  it('rejects sealing when a later lookup rolls back the observed verified prefix', async () => {
    const f = ledgerFixture(),
      earlier = f.view();
    f.addPhone();
    const observed = f.view();
    let calls = 0;
    const outcome = await result(
      Documents.sealDocument({
        scope: f.scope,
        documentKey: f.key,
        signer: f.owner.signer,
        plaintext: new Uint8Array([1]),
        ledger: () => Effect.succeed(++calls === 1 ? observed : earlier),
      })
    );
    expect(Result.isFailure(outcome)).toBe(true);
  });
  it('uses the actual non-extractable native signer and preserves caller bytes on native failure', async () => {
    const f = ledgerFixture();
    const privateKey = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(f.owner.privateKey.export({ format: 'der', type: 'pkcs8' })),
      'Ed25519',
      false,
      ['sign']
    );
    const signer = read(Signing.nativeDeviceSigner(f.owner.publicKey, privateKey));
    const plaintext = new Uint8Array([8, 9]);
    const input = {
      scope: f.scope,
      documentKey: f.key,
      signer,
      ledger: () => Effect.succeed(f.view()),
      plaintext,
    };
    const frame = await Effect.runPromise(Documents.sealDocument(input));
    expect(read(Documents.openDocument(f.view(), f.scope, f.key, frame)).plaintext).toEqual(
      plaintext
    );
    expect(privateKey.extractable).toBe(false);
    let scratch: Uint8Array | undefined;
    vi.spyOn(globalThis.crypto.subtle, 'sign').mockImplementation(
      async (_algorithm, _key, signedMessage) => {
        scratch = signedMessage as Uint8Array;
        throw new DOMException('synthetic failure', 'OperationError');
      }
    );
    const failed = await result(Documents.sealDocument(input));
    expect(Result.isFailure(failed) && failed.failure.code).toBe('sign-failed');
    expect(scratch?.every((byte) => byte === 0)).toBe(true);
    expect(plaintext).toEqual(new Uint8Array([8, 9]));
  });
  it('keeps authenticated signatures separate from ciphertext validity', async () => {
    const f = ledgerFixture();
    const valid = await Effect.runPromise(
      Documents.sealDocument({
        scope: f.scope,
        documentKey: f.key,
        signer: f.owner.signer,
        ledger: () => Effect.succeed(f.view()),
        plaintext: new Uint8Array([7]),
      })
    );
    const unsigned = valid.slice(0, -64);
    unsigned[63] ^= 1;
    const signature = f.owner.signBytes(read(contentSigningBytes(f.scope, unsigned)));
    const broken = new Uint8Array([...unsigned, ...signature]);
    expect(Result.isSuccess(Documents.authenticateDocument(f.view(), f.scope, broken))).toBe(true);
    expect(code(Documents.openDocument(f.view(), f.scope, f.key, broken))).toBe(
      'content-authentication-failed'
    );
  });
  it('retains revoked historical authors while rejecting new seals and changed scope', async () => {
    const f = ledgerFixture();
    f.addPhone();
    const input = {
      scope: f.scope,
      documentKey: f.key,
      signer: f.phone.signer,
      ledger: () => Effect.succeed(f.view()),
      plaintext: new Uint8Array([4]),
    };
    const frame = await Effect.runPromise(Documents.sealDocument(input));
    f.append([5, f.phone.raw]);
    expect(read(Documents.openDocument(f.view(), f.scope, f.key, frame)).plaintext).toEqual(
      new Uint8Array([4])
    );
    expect(Result.isFailure(await result(Documents.sealDocument(input)))).toBe(true);
    for (const scope of [
      { ...f.scope, genesis: '11'.repeat(32) },
      { ...f.scope, resource: 'elsewhere' },
      { ...f.scope, epoch: 1 },
      { ...f.scope, purpose: 'presence' as const },
    ])
      expect(Result.isFailure(Documents.openDocument(f.view(), scope, f.key, frame))).toBe(true);
  });
  it('rejects forged views, forged/imported document keys and bad injected signer output', async () => {
    const f = ledgerFixture();
    const input = {
      scope: f.scope,
      documentKey: f.key,
      signer: f.owner.signer,
      ledger: () => Effect.succeed(f.view()),
      plaintext: new Uint8Array([4]),
    };
    expect(
      Result.isFailure(
        await result(
          Documents.sealDocument({ ...input, ledger: () => Effect.succeed({ ...f.view() }) })
        )
      )
    ).toBe(true);
    expect(Result.isFailure(Documents.exportDocumentKey({} as Documents.DocumentKey))).toBe(true);
    const badSigner = {
      publicKey: f.owner.publicKey,
      sign: (message: Uint8Array) => f.attacker.signer.sign(message),
    };
    expect(
      Result.isFailure(await result(Documents.sealDocument({ ...input, signer: badSigner })))
    ).toBe(true);
    expect(
      Result.isFailure(
        await result(Documents.sealDocument({ ...input, signer: f.attacker.signer }))
      )
    ).toBe(true);
    const corrupted = read(Documents.importDocumentKey(f.scope, new Uint8Array(32)));
    const frame = await Effect.runPromise(Documents.sealDocument(input));
    expect(Result.isFailure(Documents.openDocument(f.view(), f.scope, corrupted, frame))).toBe(
      true
    );
    const broken = new Uint8Array(frame);
    broken[70] ^= 1;
    expect(Result.isFailure(Documents.authenticateDocument(f.view(), f.scope, broken))).toBe(true);
  });
  it('rechecks current view after awaiting signer and refuses a revoked in-flight producer', async () => {
    const f = ledgerFixture();
    f.addPhone();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          const signer: Signing.DeviceSigner = {
            publicKey: f.phone.publicKey,
            sign: (message) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return yield* f.phone.signer.sign(message);
              }),
          };
          const worker = yield* Effect.forkChild(
            Effect.result(
              Documents.sealDocument({
                scope: f.scope,
                documentKey: f.key,
                signer,
                ledger: () => Effect.succeed(f.view()),
                plaintext: new Uint8Array([1]),
              })
            )
          );
          yield* Deferred.await(entered);
          f.append([5, f.phone.raw]);
          yield* Deferred.succeed(release, undefined);
          expect(Result.isFailure(yield* Fiber.join(worker))).toBe(true);
        })
      )
    );
  });
  it('awaits non-cancellable native signing on interruption and clears its borrowed message scratch', async () => {
    const f = ledgerFixture();
    const privateKey = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(f.owner.privateKey.export({ format: 'der', type: 'pkcs8' })),
      'Ed25519',
      false,
      ['sign']
    );
    let scratch: Uint8Array | undefined;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          vi.spyOn(globalThis.crypto.subtle, 'sign').mockImplementation(
            async (_algo, _key, signedMessage) => {
              scratch = signedMessage as Uint8Array;
              yieldSignal(entered);
              await Effect.runPromise(Deferred.await(release));
              return f.owner.signBytes(scratch).buffer as ArrayBuffer;
            }
          );
          const signer = read(Signing.nativeDeviceSigner(f.owner.publicKey, privateKey));
          const worker = yield* Effect.forkChild(
            Signing.signVerified(signer, new Uint8Array([1, 2, 3]))
          );
          yield* Deferred.await(entered);
          // Explicit runtime interrupt request: no race with release of native work.
          worker.interruptUnsafe();
          expect(worker.pollUnsafe()).toBeUndefined();
          expect(scratch).toEqual(new Uint8Array([1, 2, 3]));
          yield* Deferred.succeed(release, undefined);
          const exit = yield* Fiber.await(worker);
          expect(scratch).toEqual(new Uint8Array(3));
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
        })
      )
    );
  });

  describe('canonical epoch commitment, history and volatile installation', () => {
    const opaque = (n: number) => read(Bytes.epochKey(new Uint8Array(32).fill(n)));
    function epochFixture() {
      const owner = identity(1),
        phone = identity(2),
        recovery = identity(3);
      const domain = (name: string, payload: Uint8Array) =>
        new Uint8Array(Buffer.concat([Buffer.from(`lody-e2ee/${name}\0`), payload]));
      const record = (body: readonly CborValue[]) =>
        read(encodeCbor([body, owner.signBytes(domain('sig/v1', read(encodeCbor(body))))]));
      const k0 = opaque(7),
        k1 = opaque(8),
        k2 = opaque(9);
      const zero = read(
        EpochKeys.commitEpochKey(read(Bytes.genesisHash(new Uint8Array(32))), 0, k0)
      );
      const records = [
        record([
          1,
          owner.raw,
          new Uint8Array(32).fill(10),
          new Uint8Array(16).fill(10),
          new Uint8Array(32).fill(100),
          zero.toBytes(),
        ]),
      ];
      const genesis = read(Bytes.genesisHash(Ledger.hashRecordBytes(records[0]!).toBytes()));
      const view = () =>
        read(
          Ledger.verifyLedger({
            anchor: genesis,
            records,
            checkpoint: { head: Ledger.hashRecordBytes(records.at(-1)!), length: records.length },
          })
        );
      const append = (op: readonly CborValue[]) =>
        records.push(record([Ledger.hashRecordBytes(records.at(-1)!).toBytes(), owner.raw, op]));
      const admit = (target: ReturnType<typeof identity>, kind: number) => {
        const enc = new Uint8Array(32).fill(120 + kind);
        const proof = target.signBytes(
          domain(
            'possess/v2',
            read(
              encodeCbor([genesis.toBytes(), new Uint8Array(16).fill(10), target.raw, enc, kind])
            )
          )
        );
        append([4, kind, target.raw, enc, proof]);
      };
      const rotate = (
        epoch: number,
        currentKey: Bytes.EpochKey,
        previousKey: Bytes.EpochKey,
        packet?: Uint8Array
      ) =>
        append([
          7,
          epoch,
          read(EpochKeys.commitEpochKey(genesis, epoch, currentKey)).toBytes(),
          packet ?? read(EpochKeys.sealHistoryPacket({ genesis, epoch, currentKey, previousKey })),
        ]);
      return {
        owner,
        phone,
        recovery,
        k0,
        k1,
        k2,
        genesis,
        view,
        append,
        admit,
        rotate,
        record,
        records,
      };
    }
    it('preserves independent Python/libsodium commitments and the exact 72-byte packet', () => {
      const genesis = read(Bytes.genesisHash(bytes(epochVector.genesis))),
        previousKey = read(Bytes.epochKey(bytes(epochVector.previous))),
        currentKey = read(Bytes.epochKey(bytes(epochVector.current)));
      expect(hex(read(EpochKeys.commitEpochKey(genesis, 0, previousKey)).toBytes())).toBe(
        epochVector.commitment0
      );
      expect(hex(read(EpochKeys.commitEpochKey(genesis, 1, currentKey)).toBytes())).toBe(
        epochVector.commitment1
      );
      vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((target) => {
        (target as Uint8Array).set(bytes(epochVector.nonce));
        return target;
      });
      const packet = read(
        EpochKeys.sealHistoryPacket({ genesis, epoch: 1, currentKey, previousKey })
      );
      expect(hex(packet)).toBe(epochVector.packet);
      expect(
        copyEpochKeyBytes(
          read(EpochKeys.openHistoryPacket({ genesis, epoch: 1, currentKey, packet }))
        )
      ).toEqual(bytes(epochVector.previous));
      const other = read(Bytes.genesisHash(new Uint8Array(32).fill(12)));
      expect(
        read(EpochKeys.commitEpochKey(other, 0, previousKey)).equals(
          read(EpochKeys.commitEpochKey(genesis, 0, previousKey))
        )
      ).toBe(true);
      expect(
        read(EpochKeys.commitEpochKey(other, 1, currentKey)).equals(
          read(EpochKeys.commitEpochKey(genesis, 1, currentKey))
        )
      ).toBe(false);
      expect(
        read(EpochKeys.commitEpochKey(genesis, 2, currentKey)).equals(
          read(EpochKeys.commitEpochKey(genesis, 1, currentKey))
        )
      ).toBe(false);
      for (const input of [
        { genesis: other, epoch: 1, currentKey, packet },
        { genesis, epoch: 2, currentKey, packet },
        { genesis, epoch: 1, currentKey: previousKey, packet },
      ])
        expect(Result.isFailure(EpochKeys.openHistoryPacket(input))).toBe(true);
    });
    it('recovers every signed historical link from real replay and fails the whole recovery on a corrupt/false old key', () => {
      const f = epochFixture();
      f.rotate(1, f.k1, f.k0);
      f.rotate(2, f.k2, f.k1);
      const keys = read(EpochKeys.recoverLedgerHistory(f.view(), f.k2));
      expect([...keys.keys()]).toEqual([2, 1, 0]);
      for (const [epoch, key] of keys)
        expect(copyEpochKeyBytes(key)).toEqual(new Uint8Array(32).fill(7 + epoch));
      expect(Result.isFailure(EpochKeys.recoverLedgerHistory(f.view(), f.k1))).toBe(true);
      expect(Result.isFailure(EpochKeys.recoverLedgerHistory({ ...f.view() }, f.k2))).toBe(true);
      const wrong = epochFixture();
      wrong.rotate(1, wrong.k1, opaque(99));
      expect(code(EpochKeys.recoverLedgerHistory(wrong.view(), wrong.k1))).toBe(
        'commitment-mismatch'
      );
      const bad = epochFixture(),
        packet = read(
          EpochKeys.sealHistoryPacket({
            genesis: bad.genesis,
            epoch: 1,
            currentKey: bad.k1,
            previousKey: bad.k0,
          })
        );
      packet[30] ^= 1;
      bad.rotate(1, bad.k1, bad.k0, packet);
      expect(code(EpochKeys.recoverLedgerHistory(bad.view(), bad.k1))).toBe('history-invalid');
    });
    it('wipes operation-owned key buffers on recovery/random failure without touching caller keys', () => {
      const f = epochFixture();
      f.rotate(1, f.k1, opaque(99));
      const view = f.view(),
        NativeBytes = Uint8Array,
        outputs: Uint8Array[] = [];
      vi.stubGlobal(
        'Uint8Array',
        new Proxy(NativeBytes, {
          construct(target, args) {
            const output = Reflect.construct(target, args) as Uint8Array;
            if (output.length === 32) outputs.push(output);
            return output;
          },
        })
      );
      expect(code(EpochKeys.recoverLedgerHistory(view, f.k1))).toBe('commitment-mismatch');
      expect(
        outputs.some(
          (value) => value.every((byte) => byte === 8) || value.every((byte) => byte === 99)
        )
      ).toBe(false);
      outputs.length = 0;
      vi.stubGlobal('crypto', {
        getRandomValues: () => {
          throw new Error('synthetic unavailable');
        },
      });
      expect(
        code(
          EpochKeys.sealHistoryPacket({
            genesis: f.genesis,
            epoch: 2,
            currentKey: f.k2,
            previousKey: f.k1,
          })
        )
      ).toBe('random-unavailable');
      expect(
        outputs.some(
          (value) => value.every((byte) => byte === 8) || value.every((byte) => byte === 9)
        )
      ).toBe(false);
      vi.unstubAllGlobals();
      expect(copyEpochKeyBytes(f.k1)).toEqual(new NativeBytes(32).fill(8));
    });
    it('has no reflective secret accessor and rejects forged key material', () => {
      const f = epochFixture(),
        key = f.k0;
      expect(Object.getPrototypeOf(key)).toBeNull();
      expect(Reflect.ownKeys(key)).toEqual([]);
      const fake = {
        [Symbol('epoch-key-material')]: () => new Uint8Array(32).fill(7),
      } as unknown as Bytes.EpochKey;
      expect(code(EpochKeys.commitEpochKey(f.genesis, 0, fake))).toBe('invalid-input');
      expect(
        code(
          deriveContentKey(fake, {
            genesis: hex(f.genesis.toBytes()),
            epoch: 0,
            resource: 'doc',
            purpose: 'doc-update',
          })
        )
      ).toBe('invalid-content-key');
    });
    it('rejects invalid epoch/packet bounds before any history result', () => {
      const f = epochFixture();
      for (const epoch of [-1, 1.5, NaN, Infinity, 2 ** 32])
        expect(Result.isFailure(EpochKeys.commitEpochKey(f.genesis, epoch, f.k0))).toBe(true);
      for (const epoch of [0, -1, 1.5, 2 ** 32])
        expect(
          Result.isFailure(
            EpochKeys.sealHistoryPacket({
              genesis: f.genesis,
              epoch,
              currentKey: f.k1,
              previousKey: f.k0,
            })
          )
        ).toBe(true);
      for (const length of [0, 71, 73, 1000])
        expect(
          Result.isFailure(
            EpochKeys.openHistoryPacket({
              genesis: f.genesis,
              epoch: 1,
              currentKey: f.k1,
              packet: new Uint8Array(length),
            })
          )
        ).toBe(true);
    });
  });
});
function yieldSignal(signal: Deferred.Deferred<void>) {
  Effect.runSync(Deferred.succeed(signal, undefined));
}
