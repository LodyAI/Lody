import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cause, Effect, Exit, Fiber, Result } from 'effect';
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import * as Public from '../src/index';
import { copyEpochKeyBytes } from '../src/epoch-key';
import vector from './hpke-vector.json';

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
function ok<A, E>(result: Result.Result<A, E>): A {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}
const v = vector.epoch;
const context: Public.EpochHpkeContext = {
  genesis: ok(Public.Bytes.genesisHash(bytes(v.genesis))),
  epoch: ok(Public.Bytes.epochNumber(v.epoch)),
  sender: ok(Public.Bytes.signingPublicKey(bytes(v.sender))),
  recipient: ok(Public.Bytes.signingPublicKey(bytes(v.recipient))),
};
const recipient = ok(Public.Bytes.encryptionPublicKey(bytes(v.pkR)));
const key = ok(Public.Bytes.epochKey(bytes(v.pt)));
const payload = () => ({ enc: bytes(v.enc), ct: bytes(v.ct) });
const suite = () =>
  new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
async function pair(privateHex = v.skR, publicHex = v.pkR): Promise<CryptoKeyPair> {
  const kem = suite().kem;
  return {
    privateKey: await kem.deserializePrivateKey(bytes(privateHex)),
    publicKey: await kem.deserializePublicKey(bytes(publicHex)),
  };
}
async function failure<A, E>(effect: Effect.Effect<A, E>) {
  const result = await Effect.runPromise(Effect.result(effect));
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) throw new Error('unexpected success');
  return result.failure;
}
function deterministicRandom() {
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((target) => {
    (target as Uint8Array).set(bytes(v.ikmE));
    return target;
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('fixed Base HPKE epoch primitive through the public entry', () => {
  it('matches independent RFC 9180 A.2.1 encryption and decryption', async () => {
    const r = vector.rfc;
    const cipher = suite();
    const keys = await pair(r.skR, r.pkR);
    const sealed = await cipher.seal(
      { recipientPublicKey: keys.publicKey, ekm: bytes(r.ikmE), info: bytes(r.info) },
      bytes(r.pt),
      bytes(r.aad)
    );
    expect(hex(new Uint8Array(sealed.enc))).toBe(r.enc);
    expect(hex(new Uint8Array(sealed.ct))).toBe(r.ct);
    expect(
      hex(
        new Uint8Array(
          await cipher.open(
            { recipientKey: keys, enc: sealed.enc, info: bytes(r.info) },
            sealed.ct,
            bytes(r.aad)
          )
        )
      )
    ).toBe(r.pt);
  });

  it('matches independently encoded epoch AAD and Python HPKE bytes', async () => {
    deterministicRandom();
    expect(hex(ok(Public.epochHpkeAad(context)))).toBe(v.aad);
    const sealed = await Effect.runPromise(Public.sealEpochKeyHpke(recipient, key, context));
    expect(sealed).toEqual(payload());
    const opened = await Effect.runPromise(
      Public.openEpochKeyHpke(await pair(), recipient, context, sealed)
    );
    expect(hex(copyEpochKeyBytes(opened))).toBe(v.pt);
    expect(Object.keys(opened)).toEqual([]);
  });

  it('runs with host secure randomness, fresh seals and non-extractable native private keys', async () => {
    const keys = (await globalThis.crypto.subtle.generateKey({ name: 'X25519' }, false, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', keys.publicKey));
    const publicKey = ok(Public.Bytes.encryptionPublicKey(raw));
    expect(keys.privateKey.extractable).toBe(false);
    const first = await Effect.runPromise(Public.sealEpochKeyHpke(publicKey, key, context));
    const second = await Effect.runPromise(Public.sealEpochKeyHpke(publicKey, key, context));
    expect(first.enc).not.toEqual(second.enc);
    for (const sealed of [first, second]) {
      expect(sealed.enc.length).toBe(32);
      expect(sealed.ct.length).toBe(48);
      const opened = await Effect.runPromise(
        Public.openEpochKeyHpke(keys, publicKey, context, sealed)
      );
      expect(hex(copyEpochKeyBytes(opened))).toBe(v.pt);
    }
  });

  it.each(['genesis', 'epoch', 'sender', 'recipient'] as const)(
    'rejects a different trusted %s',
    async (field) => {
      const changed = { ...context };
      if (field === 'genesis')
        changed.genesis = ok(Public.Bytes.genesisHash(new Uint8Array(32).fill(9)));
      if (field === 'epoch') changed.epoch = ok(Public.Bytes.epochNumber(257));
      if (field === 'sender') changed.sender = context.recipient;
      if (field === 'recipient') changed.recipient = context.sender;
      expect(
        await failure(Public.openEpochKeyHpke(await pair(), recipient, changed, payload()))
      ).toMatchObject({ code: 'open-failed' });
    }
  );

  it.each([-1, 1.5, 0x1_0000_0000, NaN])(
    'rejects invalid epoch %s before crypto',
    async (epoch) => {
      const invalid = { ...context, epoch } as Public.EpochHpkeContext;
      expect(Result.isFailure(Public.epochHpkeAad(invalid))).toBe(true);
      await failure(Public.sealEpochKeyHpke(recipient, key, invalid));
    }
  );

  it('revalidates malformed context and forged key wrappers', async () => {
    for (const field of ['genesis', 'sender', 'recipient'] as const) {
      const invalid = {
        ...context,
        [field]: { toBytes: () => new Uint8Array(31) },
      } as unknown as Public.EpochHpkeContext;
      expect(Result.isFailure(Public.epochHpkeAad(invalid))).toBe(true);
      await failure(Public.sealEpochKeyHpke(recipient, key, invalid));
    }
    await failure(
      Public.sealEpochKeyHpke(
        { toBytes: () => new Uint8Array(31) } as unknown as Public.Bytes.EncryptionPublicKey,
        key,
        context
      )
    );
    expect(
      await failure(Public.sealEpochKeyHpke(recipient, {} as Public.Bytes.EpochKey, context))
    ).toMatchObject({ code: 'invalid-input' });
  });

  it.each([0, 31, 33, 1024 * 1024])(
    'rejects encapsulated-key length %s before copying',
    async (length) => {
      await failure(
        Public.openEpochKeyHpke(await pair(), recipient, context, {
          ...payload(),
          enc: new Uint8Array(length),
        })
      );
    }
  );
  it.each([0, 47, 49, 1024 * 1024])(
    'rejects ciphertext length %s before copying',
    async (length) => {
      await failure(
        Public.openEpochKeyHpke(await pair(), recipient, context, {
          ...payload(),
          ct: new Uint8Array(length),
        })
      );
    }
  );

  it('rejects tampering, low-order encapsulation and mismatched local recipient', async () => {
    const keys = await pair();
    for (const field of ['enc', 'ct'] as const) {
      const changed = payload();
      changed[field][0] ^= 1;
      expect(
        await failure(Public.openEpochKeyHpke(keys, recipient, context, changed))
      ).toMatchObject({ code: 'open-failed' });
    }
    await failure(
      Public.openEpochKeyHpke(keys, recipient, context, { ...payload(), enc: new Uint8Array(32) })
    );
    const other = await suite().kem.generateKeyPair();
    expect(
      await failure(Public.openEpochKeyHpke(other, recipient, context, payload()))
    ).toMatchObject({ code: 'recipient-mismatch' });
    const low = new Uint8Array(32);
    low[0] = 1;
    await failure(Public.sealEpochKeyHpke(ok(Public.Bytes.encryptionPublicKey(low)), key, context));
  });

  it('rejects old info and arbitrary plaintext lengths without changing the public suite', async () => {
    const keys = await pair();
    const aad = bytes(v.aad);
    for (const [info, plaintext] of [
      [new TextEncoder().encode('lody-epoch-key-hpke/v1'), bytes(v.pt)],
      [bytes(v.info), new Uint8Array(31)],
    ]) {
      const sealed = await suite().seal(
        { recipientPublicKey: keys.publicKey, ekm: bytes(v.ikmE), info },
        plaintext,
        aad
      );
      await failure(
        Public.openEpochKeyHpke(keys, recipient, context, {
          enc: new Uint8Array(sealed.enc),
          ct: new Uint8Array(sealed.ct),
        })
      );
    }
  });

  it('wipes owned random and plaintext buffers after random failure while preserving caller key', async () => {
    let random: Uint8Array | undefined;
    const wiped: Uint8Array[] = [];
    const fill = Uint8Array.prototype.fill;
    vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
      this: Uint8Array,
      value,
      ...rest
    ) {
      if (hex(this) === v.pt) wiped.push(this);
      return fill.call(this, value, ...rest);
    });
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((target) => {
      random = target as Uint8Array;
      random.fill(7);
      throw new Error(v.pt);
    });
    const result = await failure(Public.sealEpochKeyHpke(recipient, key, context));
    expect(result).toMatchObject({ code: 'random-unavailable' });
    expect(JSON.stringify(result)).not.toContain(v.pt);
    expect(random).toEqual(new Uint8Array(32));
    expect(wiped.length).toBeGreaterThan(0);
    for (const value of wiped) expect(value).toEqual(new Uint8Array(32));
    expect(hex(copyEpochKeyBytes(key))).toBe(v.pt);
  });

  it('wipes native open plaintext after copying it into an opaque result', async () => {
    const original = CipherSuite.prototype.open;
    let native: Uint8Array | undefined;
    vi.spyOn(CipherSuite.prototype, 'open').mockImplementation(async function (
      this: CipherSuite,
      ...args
    ) {
      const result = await original.apply(this, args);
      native = new Uint8Array(result);
      return result;
    });
    const opened = await Effect.runPromise(
      Public.openEpochKeyHpke(await pair(), recipient, context, payload())
    );
    expect(native).toEqual(new Uint8Array(32));
    expect(hex(copyEpochKeyBytes(opened))).toBe(v.pt);
  });

  it('awaits native completion and wipes temporary buffers on scoped interruption', async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let plaintext!: Uint8Array, random!: Uint8Array;
    vi.spyOn(CipherSuite.prototype, 'seal').mockImplementation(async (params, pt) => {
      plaintext = pt as Uint8Array;
      random = params.ekm as Uint8Array;
      enter();
      await released;
      throw new Error('native failure');
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* Effect.forkChild(Public.sealEpochKeyHpke(recipient, key, context));
          yield* Effect.promise(() => entered);
          const stopping = yield* Effect.forkChild(Fiber.interrupt(worker));
          yield* Effect.yieldNow;
          expect(hex(plaintext)).toBe(v.pt);
          try {
            expect(stopping.pollUnsafe()).toBeUndefined();
          } finally {
            release();
          }
          yield* Fiber.join(stopping);
          const exit = yield* Fiber.await(worker);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          expect(plaintext).toEqual(new Uint8Array(32));
          expect(random).toEqual(new Uint8Array(32));
          expect(hex(copyEpochKeyBytes(key))).toBe(v.pt);
        })
      )
    );
  });
  it('rejects an absent host random source without library fallback', async () => {
    vi.stubGlobal('crypto', undefined);
    expect(await failure(Public.sealEpochKeyHpke(recipient, key, context))).toMatchObject({
      code: 'random-unavailable',
    });
  });

  it('wipes owned buffers after native failure and rejects invalid native output', async () => {
    deterministicRandom();
    let plaintext!: Uint8Array, random!: Uint8Array;
    const stub = vi.spyOn(CipherSuite.prototype, 'seal').mockImplementation(async (params, pt) => {
      plaintext = pt as Uint8Array;
      random = params.ekm as Uint8Array;
      throw new Error(v.pt);
    });
    const failed = await failure(Public.sealEpochKeyHpke(recipient, key, context));
    expect(failed).toMatchObject({ code: 'seal-failed' });
    expect(JSON.stringify(failed)).not.toContain(v.pt);
    expect(plaintext).toEqual(new Uint8Array(32));
    expect(random).toEqual(new Uint8Array(32));
    stub.mockImplementation(async (params, pt) => {
      plaintext = pt as Uint8Array;
      random = params.ekm as Uint8Array;
      return { enc: new ArrayBuffer(31), ct: new ArrayBuffer(48) };
    });
    expect(await failure(Public.sealEpochKeyHpke(recipient, key, context))).toMatchObject({
      code: 'seal-failed',
    });
    expect(plaintext).toEqual(new Uint8Array(32));
    expect(random).toEqual(new Uint8Array(32));
  });

  it('captures payload bytes before asynchronous local-key verification', async () => {
    const keys = await pair(),
      input = payload();
    const kem = suite().kem;
    const prototype = Object.getPrototypeOf(kem);
    const original = prototype.serializePublicKey;
    vi.spyOn(prototype, 'serializePublicKey').mockImplementation(async function (
      this: typeof kem,
      ...args: unknown[]
    ) {
      input.enc.fill(0);
      input.ct.fill(0);
      return original.apply(this, args);
    });
    const opened = await Effect.runPromise(
      Public.openEpochKeyHpke(keys, recipient, context, input)
    );
    expect(hex(copyEpochKeyBytes(opened))).toBe(v.pt);
    expect(input).toEqual({ enc: new Uint8Array(32), ct: new Uint8Array(48) });
  });
});
