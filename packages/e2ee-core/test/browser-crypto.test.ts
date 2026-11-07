import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cause, Effect, Exit, Fiber, Result } from 'effect';
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { X25519 as JsCurve } from '@hpke/dhkem-x25519';
import { importBrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import * as Public from '@lody/e2ee-core/protocol';
import { copyEpochKeyBytes } from '../src/internal/foundation/epoch-key';
import { setEd25519WasmEnabled } from '../src/internal/foundation/ed25519-wasm';
import vector from './hpke-vector.json';

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const ok = <A, E>(value: Result.Result<A, E>) => Result.getOrThrow(value);
const seed = () => bytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
const signingPublic = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const signature =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
const v = vector.epoch;
const context: Public.EpochHpkeContext = {
  genesis: ok(Public.Bytes.genesisHash(bytes(v.genesis))),
  epoch: ok(Public.Bytes.epochNumber(v.epoch)),
  sender: ok(Public.Bytes.signingPublicKey(bytes(v.sender))),
  recipient: ok(Public.Bytes.signingPublicKey(bytes(v.recipient))),
};
const epochKey = ok(Public.Bytes.epochKey(bytes(v.pt)));
const payload = () => ({ enc: bytes(v.enc), ct: bytes(v.ct) });
const device = () =>
  importBrowserDevice({ signingPrivate: seed(), encryptionPrivate: bytes(v.skR) });
const nativeSuite = () =>
  new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
const nativePair = async () => {
  const kem = nativeSuite().kem;
  return {
    privateKey: await kem.deserializePrivateKey(bytes(v.skR)),
    publicKey: await kem.deserializePublicKey(bytes(v.pkR)),
  };
};
const result = <A, E, R = never>(work: Effect.Effect<A, E, R>) => Effect.result(work);
const rejectNativeCurves = () => {
  const subtle = globalThis.crypto.subtle;
  const importKey = subtle.importKey.bind(subtle);
  const nativeSign = subtle.sign.bind(subtle);
  vi.spyOn(subtle, 'importKey').mockImplementation((...args) => {
    const name = typeof args[2] === 'string' ? args[2] : args[2].name;
    if (name === 'Ed25519' || name === 'X25519')
      return Promise.reject(new DOMException('curve unsupported', 'NotSupportedError'));
    return importKey(...args);
  });
  vi.spyOn(subtle, 'sign').mockImplementation((algorithm, key, data) => {
    if ((typeof algorithm === 'string' ? algorithm : algorithm.name) === 'Ed25519')
      return Promise.reject(new DOMException('curve unsupported', 'NotSupportedError'));
    return nativeSign(algorithm, key, data);
  });
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setEd25519WasmEnabled(true);
});

describe('opt-in browser curve capabilities', () => {
  it('owns independent imported private bytes, matches RFC Ed25519 and exposes no raw private handle', async () => {
    const signing = seed(),
      encryption = bytes(v.skR);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const d = yield* importBrowserDevice({
            signingPrivate: signing,
            encryptionPrivate: encryption,
          });
          signing.fill(0);
          encryption.fill(0);
          expect(hex(d.publicKey.toBytes())).toBe(signingPublic);
          expect(hex(d.enc.toBytes())).toBe(v.pkR);
          expect(hex((yield* Public.signVerified(d, new Uint8Array())).toBytes())).toBe(signature);
          expect(d.encryption.privateKey.extractable).toBe(false);
          expect(Object.keys(d.encryption.privateKey).sort()).toEqual([
            'algorithm',
            'extractable',
            'type',
            'usages',
          ]);
          yield* Effect.promise(() =>
            expect(
              globalThis.crypto.subtle.exportKey('pkcs8', d.encryption.privateKey)
            ).rejects.toThrow()
          );
          const opened = yield* Public.openEpochKeyHpke(d.encryption, d.enc, context, payload());
          expect(hex(copyEpochKeyBytes(opened))).toBe(v.pt);
        })
      )
    );
  });

  it('signs, strictly verifies, seals and opens while WASM and native Ed25519/X25519 are unavailable', async () => {
    setEd25519WasmEnabled(false);
    rejectNativeCurves();
    const random = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((target) => {
      if ((target as Uint8Array).length === 32) (target as Uint8Array).set(bytes(v.ikmE));
      else random(target);
      return target;
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const d = yield* device();
          const signed = yield* Public.signVerified(d, Uint8Array.of(71, 12, 21));
          expect(
            Result.isSuccess(
              Public.verifySignature(
                d.publicKey.toBytes(),
                Uint8Array.of(71, 12, 21),
                signed.toBytes()
              )
            )
          ).toBe(true);
          expect(
            Result.isFailure(
              Public.verifySignature(
                d.publicKey.toBytes(),
                Uint8Array.of(71, 12, 22),
                signed.toBytes()
              )
            )
          ).toBe(true);
          expect(yield* Public.sealEpochKeyHpke(d.enc, epochKey, context)).toEqual(payload());
          expect(
            hex(
              copyEpochKeyBytes(
                yield* Public.openEpochKeyHpke(d.encryption, d.enc, context, payload())
              )
            )
          ).toBe(v.pt);
        })
      )
    );
  });

  it('interoperates both ways with the original native HPKE suite at fixed bytes', async () => {
    const keys = await nativePair(),
      cipher = nativeSuite();
    const native = await cipher.seal(
      { recipientPublicKey: keys.publicKey, ekm: bytes(v.ikmE), info: bytes(v.info) },
      bytes(v.pt),
      bytes(v.aad)
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const d = yield* device();
          expect(
            hex(
              copyEpochKeyBytes(
                yield* Public.openEpochKeyHpke(d.encryption, d.enc, context, {
                  enc: new Uint8Array(native.enc),
                  ct: new Uint8Array(native.ct),
                })
              )
            )
          ).toBe(v.pt);
          vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((target) => {
            (target as Uint8Array).set(bytes(v.ikmE));
            return target;
          });
          const sealed = yield* Public.sealEpochKeyHpke(d.enc, epochKey, context);
          expect(sealed).toEqual(payload());
          const opened = yield* Effect.promise(() =>
            cipher.open(
              { recipientKey: keys, enc: sealed.enc, info: bytes(v.info) },
              sealed.ct,
              bytes(v.aad)
            )
          );
          expect(hex(new Uint8Array(opened))).toBe(v.pt);
        })
      )
    );
  });

  it('rejects substituted AAD, recipients, low-order encapsulation and modified ciphertext', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const d = yield* device();
          for (const changed of [
            { ...context, epoch: ok(Public.Bytes.epochNumber(v.epoch + 1)) },
            { ...context, genesis: ok(Public.Bytes.genesisHash(new Uint8Array(32).fill(73))) },
            { ...context, sender: context.recipient },
            { ...context, recipient: context.sender },
          ])
            expect(
              Result.isFailure(
                yield* result(Public.openEpochKeyHpke(d.encryption, d.enc, changed, payload()))
              )
            ).toBe(true);
          for (const enc of [
            new Uint8Array(32),
            Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0)),
          ])
            expect(
              Result.isFailure(
                yield* result(
                  Public.openEpochKeyHpke(d.encryption, d.enc, context, { ...payload(), enc })
                )
              )
            ).toBe(true);
          const ct = bytes(v.ct);
          ct[0] ^= 1;
          expect(
            Result.isFailure(
              yield* result(
                Public.openEpochKeyHpke(d.encryption, d.enc, context, { ...payload(), ct })
              )
            )
          ).toBe(true);
          expect(
            Result.isFailure(
              yield* result(
                Public.openEpochKeyHpke(
                  d.encryption,
                  ok(Public.Bytes.encryptionPublicKey(new Uint8Array(32).fill(7))),
                  context,
                  payload()
                )
              )
            )
          ).toBe(true);
          const other = yield* device();
          expect(
            Result.isFailure(
              yield* result(
                Public.openEpochKeyHpke(
                  { privateKey: d.encryption.privateKey, publicKey: other.encryption.publicKey },
                  d.enc,
                  context,
                  payload()
                )
              )
            )
          ).toBe(true);
          expect(
            Result.isFailure(
              yield* result(
                Public.openEpochKeyHpke(structuredClone(d.encryption), d.enc, context, payload())
              )
            )
          ).toBe(true);
        })
      )
    );
  });

  it('closes admission synchronously and drains interrupted HPKE before completing close', async () => {
    let retained: Uint8Array | undefined;
    const deserialize = JsCurve.prototype.deserializePrivateKey;
    vi.spyOn(JsCurve.prototype, 'deserializePrivateKey').mockImplementation(function (
      this: JsCurve,
      ...args
    ) {
      expect(args[0]).toBeInstanceOf(ArrayBuffer);
      retained = new Uint8Array(args[0] as ArrayBuffer);
      return deserialize.apply(this, args);
    });
    let entered!: () => void, release!: () => void;
    const arrival = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const open = CipherSuite.prototype.open;
    vi.spyOn(CipherSuite.prototype, 'open').mockImplementation(async function (
      this: CipherSuite,
      ...args
    ) {
      entered();
      await gate;
      return open.apply(this, args);
    });
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const d = yield* device();
            const opening = yield* Effect.forkChild(
              Public.openEpochKeyHpke(d.encryption, d.enc, context, payload())
            );
            yield* Effect.promise(() => arrival);
            opening.interruptUnsafe();
            const closing = yield* Effect.forkChild(d.close, { startImmediately: true });
            try {
              expect(retained).toEqual(bytes(v.skR));
              expect(closing.pollUnsafe()).toBeUndefined();
              expect(Result.isFailure(yield* result(d.sign(new Uint8Array())))).toBe(true);
              expect(
                Result.isFailure(
                  yield* result(Public.openEpochKeyHpke(d.encryption, d.enc, context, payload()))
                )
              ).toBe(true);
            } finally {
              release();
            }
            const exit = yield* Fiber.await(opening);
            expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
            yield* Fiber.join(closing);
            expect(retained).toEqual(new Uint8Array(32));
            yield* d.close;
          })
        )
      );
    } finally {
      release();
    }
  });

  it('does not resume handles after Scope release and rejects invalid private input', async () => {
    const d = await Effect.runPromise(Effect.scoped(device()));
    expect(Result.isFailure(await Effect.runPromise(result(d.sign(new Uint8Array()))))).toBe(true);
    expect(
      Result.isFailure(
        await Effect.runPromise(
          result(Public.openEpochKeyHpke(d.encryption, d.enc, context, payload()))
        )
      )
    ).toBe(true);
    for (const length of [0, 31, 33])
      expect(
        Result.isFailure(
          await Effect.runPromise(
            Effect.scoped(
              result(
                importBrowserDevice({
                  signingPrivate: new Uint8Array(length),
                  encryptionPrivate: bytes(v.skR),
                })
              )
            )
          )
        )
      ).toBe(true);
  });
});
