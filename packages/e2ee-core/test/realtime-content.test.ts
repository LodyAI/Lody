import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cause, Deferred, Effect, Exit, Fiber, Result } from 'effect';
import * as P from '@lody/e2ee-core/protocol';
import * as Crypto from '../src/internal/crypto/content';
import { copyEpochKeyBytes, disposeEpochKey } from '../src/internal/foundation/epoch-key';
import { envelopeFixture } from './keys/fixture';
import vector from './realtime-content-vector.json';

const read = <A, E>(value: Result.Result<A, E>): A => Result.getOrThrow(value);
const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const scope: P.DocumentScope = {
  genesis: vector.genesis,
  epoch: vector.epoch,
  resource: vector.resource,
};
const pairs = [
  ['presence', P.sealPresenceContent, P.openPresenceContent],
  ['rpc-request', P.sealRpcRequestContent, P.openRpcRequestContent],
  ['rpc-response', P.sealRpcResponseContent, P.openRpcResponseContent],
] as const;
function identity(seed = vector.seed) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), bytes(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = read(
    P.Bytes.signingPublicKey(
      createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
    )
  );
  const signBytes = (message: Uint8Array) => new Uint8Array(sign(null, message, privateKey));
  const signer: P.DeviceSigner = {
    publicKey,
    sign: (message) => Effect.sync(() => read(P.Bytes.signature(signBytes(message)))),
  };
  return { privateKey, publicKey, signBytes, signer };
}
function fixture() {
  return {
    scope: { ...scope },
    epochKey: read(P.Bytes.epochKey(bytes(vector.epochKey))),
    signer: identity().signer,
    plaintext: bytes(vector.plaintext),
    additionalData: new Uint8Array([1, 2, 3]),
  };
}
const openInput = (input: ReturnType<typeof fixture>, frame: Uint8Array) => ({
  scope: input.scope,
  epochKey: input.epochKey,
  expectedSigner: input.signer.publicKey,
  frame,
  additionalData: input.additionalData,
});
function code(value: Result.Result<unknown, { readonly code: string }>) {
  expect(Result.isFailure(value)).toBe(true);
  return Result.isFailure(value) ? value.failure.code : undefined;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('purpose-specific opaque realtime content', () => {
  it.each(vector.cases)(
    'matches independent Python HMAC + libsodium full-frame vector: $purpose / $binding',
    async (test) => {
      const pair = pairs.find(([purpose]) => purpose === test.purpose)!;
      const input = { ...fixture(), additionalData: bytes(test.binding) };
      vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((out) => {
        (out as Uint8Array).set(bytes(vector.nonce));
        return out;
      });
      const frame = await Effect.runPromise(pair[1](input));
      expect(hex(frame)).toBe(test.frame);
      const plaintext = read(pair[2](openInput(input, bytes(test.frame))));
      expect(hex(plaintext)).toBe(vector.plaintext);
      plaintext.fill(0);
      expect(hex(input.plaintext)).toBe(vector.plaintext);
      expect(hex(copyEpochKeyBytes(input.epochKey))).toBe(vector.epochKey);
    }
  );

  it.each(pairs)(
    'isolates %s from purpose, genesis, epoch, resource, binding and other valid signers',
    async (_, seal, open) => {
      const input = fixture();
      const frame = await Effect.runPromise(seal(input));
      const original = openInput(input, frame);
      for (const [, , otherOpen] of pairs) {
        if (otherOpen !== open) expect(Result.isFailure(otherOpen(original))).toBe(true);
      }
      for (const replacement of [
        { genesis: '22'.repeat(32) },
        { epoch: scope.epoch + 1 },
        { resource: 'realtime-target-b' },
      ]) {
        expect(Result.isFailure(open({ ...original, scope: { ...scope, ...replacement } }))).toBe(
          true
        );
      }
      expect(
        Result.isFailure(open({ ...original, additionalData: new Uint8Array([1, 2, 4]) }))
      ).toBe(true);
      const attacker = identity('42'.repeat(32));
      const attackerFrame = await Effect.runPromise(seal({ ...input, signer: attacker.signer }));
      expect(code(open({ ...original, frame: attackerFrame }))).toBe('content-signer-mismatch');
      expect(code(open({ ...original, expectedSigner: attacker.publicKey }))).toBe(
        'content-signer-mismatch'
      );
      const damaged = frame.slice();
      damaged[damaged.length - 1]! ^= 1;
      // Signature validation precedes even trying the invalid epoch-key capability.
      disposeEpochKey(input.epochKey);
      expect(code(open({ ...original, frame: damaged }))).toBe('bad-content-signature');
    }
  );

  it.each(pairs)(
    'rejects valid re-signing of %s ciphertext under another context at AEAD',
    async (purpose, seal, open) => {
      const input = fixture(),
        id = identity();
      const frame = await Effect.runPromise(seal(input));
      const changedScope = { ...scope, resource: 'realtime-target-b' };
      const unsigned = frame.subarray(0, -64);
      const rebound = new Uint8Array(
        Buffer.concat([
          unsigned,
          id.signBytes(
            read(
              P.contentSigningBytes({ ...changedScope, purpose }, unsigned, input.additionalData)
            )
          ),
        ])
      );
      expect(code(open({ ...openInput(input, rebound), scope: changedScope }))).toBe(
        'content-authentication-failed'
      );
    }
  );

  it('leaves document purposes restricted', async () => {
    const f = envelopeFixture();
    for (const [purpose] of pairs) {
      const wrongScope = {
        genesis: hex(f.view().genesis.toBytes()),
        epoch: 0,
        resource: 'doc',
        purpose,
      };
      const invalidKey = {} as P.DocumentKey;
      const result = await Effect.runPromise(
        Effect.result(
          P.sealDocument({
            scope: wrongScope,
            documentKey: invalidKey,
            signer: f.owner.signer,
            plaintext: new Uint8Array([1]),
            ledger: () => Effect.succeed(f.view()),
          })
        )
      );
      expect(code(result)).toBe('invalid-document-purpose');
      // Authenticate with a genuine ledger; the wrong purpose is rejected before AEAD.
      const input = { ...fixture(), scope: wrongScope };
      const frame = await Effect.runPromise(pairs.find(([p]) => p === purpose)![1](input));
      expect(code(P.authenticateDocument(f.view(), wrongScope, frame))).toBe(
        'invalid-document-purpose'
      );
    }
  });

  it('is inert and captures scope, bytes, binding and signer capability before asynchronous work', async () => {
    const input = fixture();
    const original = {
      ...openInput(input, new Uint8Array()),
      scope: { ...input.scope },
      additionalData: input.additionalData.slice(),
    };
    const epochKey = input.epochKey;
    const id = identity();
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        let called = false;
        const signer: {
          publicKey: P.Bytes.SigningPublicKey;
          sign: (message: Uint8Array) => Effect.Effect<P.Bytes.Signature, P.ContentError>;
        } = {
          publicKey: id.publicKey,
          sign: (message: Uint8Array) =>
            Effect.gen(function* () {
              called = true;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return read(P.Bytes.signature(id.signBytes(message)));
            }),
        };
        input.signer = signer;
        const effect = P.sealRpcRequestContent(input);
        expect(called).toBe(false);
        const fiber = yield* Effect.forkChild(effect);
        yield* Deferred.await(entered);
        input.scope.resource = 'changed';
        input.plaintext.fill(99);
        input.additionalData.fill(99);
        signer.publicKey = identity('42'.repeat(32)).publicKey;
        signer.sign = () => Effect.fail(new P.ContentError({ code: 'replacement' }));
        input.epochKey = {} as P.Bytes.EpochKey;
        yield* Deferred.succeed(release, undefined);
        const frame = yield* Fiber.join(fiber);
        expect(hex(read(P.openRpcRequestContent({ ...original, epochKey, frame })))).toBe(
          vector.plaintext
        );
      })
    );
  });

  it('enforces existing plaintext and binding maxima before copying', async () => {
    const NativeBytes = Uint8Array;
    const oversized = new NativeBytes(16 * 1024 * 1024 + 1);
    const binding = new NativeBytes(1025);
    let copiedOversized = false;
    vi.stubGlobal(
      'Uint8Array',
      new Proxy(NativeBytes, {
        construct(target, args) {
          if (args[0] === oversized || args[0] === binding) copiedOversized = true;
          return Reflect.construct(target, args);
        },
      })
    );
    expect(
      code(
        await Effect.runPromise(
          Effect.result(P.sealRpcRequestContent({ ...fixture(), plaintext: oversized }))
        )
      )
    ).toBe('content-too-large');
    expect(
      code(
        await Effect.runPromise(
          Effect.result(P.sealRpcRequestContent({ ...fixture(), additionalData: binding }))
        )
      )
    ).toBe('invalid-content-additional-data');
    expect(copiedOversized).toBe(false);
  });

  it('releases derived leaves and plaintext scratch on signing success and failure, retaining borrowed epoch', async () => {
    for (const shouldFail of [false, true]) {
      const input = fixture();
      const derived: Crypto.ContentKey[] = [];
      const realDerive = Crypto.deriveContentKey;
      const spy = vi.spyOn(Crypto, 'deriveContentKey').mockImplementation((...args) => {
        const result = realDerive(...args);
        if (Result.isSuccess(result)) derived.push(result.success);
        return result;
      });
      const NativeBytes = Uint8Array;
      const plaintextCopies: Uint8Array[] = [];
      vi.stubGlobal(
        'Uint8Array',
        new Proxy(NativeBytes, {
          construct(target, args) {
            const out = Reflect.construct(target, args) as Uint8Array;
            if (args[0] instanceof NativeBytes && hex(args[0]) === vector.plaintext)
              plaintextCopies.push(out);
            return out;
          },
        })
      );
      if (shouldFail)
        input.signer = {
          ...input.signer,
          sign: () => Effect.fail(new P.ContentError({ code: 'synthetic-sign-failure' })),
        };
      const result = await Effect.runPromise(Effect.result(P.sealRpcRequestContent(input)));
      expect(Result.isFailure(result)).toBe(shouldFail);
      expect(plaintextCopies.length).toBeGreaterThan(0);
      for (const copy of plaintextCopies) expect(copy.every((n) => n === 0)).toBe(true);
      expect(hex(input.plaintext)).toBe(vector.plaintext);
      for (const key of derived)
        expect(
          code(
            Crypto.sealContentAead(
              key,
              { ...scope, purpose: 'rpc-request', docEpoch: 0, device: vector.publicKey },
              new NativeBytes()
            )
          )
        ).toBe('invalid-content-key');
      expect(derived.length).toBe(1);
      expect(hex(copyEpochKeyBytes(input.epochKey))).toBe(vector.epochKey);
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('releases open leaves after success and AEAD failure, and does not derive before signature verification', async () => {
    const input = fixture();
    const frame = await Effect.runPromise(P.sealRpcResponseContent(input));
    const id = identity();
    const derived: Crypto.ContentKey[] = [];
    const realDerive = Crypto.deriveContentKey;
    vi.spyOn(Crypto, 'deriveContentKey').mockImplementation((...args) => {
      const result = realDerive(...args);
      if (Result.isSuccess(result)) derived.push(result.success);
      return result;
    });
    expect(hex(read(P.openRpcResponseContent(openInput(input, frame))))).toBe(vector.plaintext);
    const changedScope = { ...scope, resource: 'realtime-target-b' };
    const unsigned = frame.subarray(0, -64);
    const rebound = new Uint8Array(
      Buffer.concat([
        unsigned,
        id.signBytes(
          read(
            P.contentSigningBytes(
              { ...changedScope, purpose: 'rpc-response' },
              unsigned,
              input.additionalData
            )
          )
        ),
      ])
    );
    expect(
      code(P.openRpcResponseContent({ ...openInput(input, rebound), scope: changedScope }))
    ).toBe('content-authentication-failed');
    const damaged = frame.slice();
    damaged[damaged.length - 1]! ^= 1;
    expect(code(P.openRpcResponseContent(openInput(input, damaged)))).toBe('bad-content-signature');
    expect(derived.length).toBe(2);
    for (const key of derived)
      expect(
        code(
          Crypto.sealContentAead(
            key,
            { ...scope, purpose: 'rpc-response', docEpoch: 0, device: vector.publicKey },
            new Uint8Array()
          )
        )
      ).toBe('invalid-content-key');
    expect(hex(copyEpochKeyBytes(input.epochKey))).toBe(vector.epochKey);
  });

  it('wipes plaintext scratch and releases the leaf after a random-source failure, allowing the next call to recover', async () => {
    const input = fixture();
    const NativeBytes = Uint8Array;
    const copies: Uint8Array[] = [];
    const derived: Crypto.ContentKey[] = [];
    const realDerive = Crypto.deriveContentKey;
    vi.spyOn(Crypto, 'deriveContentKey').mockImplementation((...args) => {
      const result = realDerive(...args);
      if (Result.isSuccess(result)) derived.push(result.success);
      return result;
    });
    vi.stubGlobal(
      'Uint8Array',
      new Proxy(NativeBytes, {
        construct(target, args) {
          const out = Reflect.construct(target, args) as Uint8Array;
          if (args[0] instanceof NativeBytes && hex(args[0]) === vector.plaintext) copies.push(out);
          return out;
        },
      })
    );
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('synthetic random failure');
    });
    expect(code(await Effect.runPromise(Effect.result(P.sealPresenceContent(input))))).toBe(
      'content-random-unavailable'
    );
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) expect(copy.every((n) => n === 0)).toBe(true);
    expect(
      code(
        Crypto.sealContentAead(
          derived[0]!,
          { ...scope, purpose: 'presence', docEpoch: 0, device: vector.publicKey },
          new NativeBytes()
        )
      )
    ).toBe('invalid-content-key');
    random.mockRestore();
    const frame = await Effect.runPromise(P.sealPresenceContent(input));
    expect(hex(read(P.openPresenceContent(openInput(input, frame))))).toBe(vector.plaintext);
    expect(hex(input.plaintext)).toBe(vector.plaintext);
  });

  it('awaits non-cancellable native signing completion on interruption and then releases its derived leaf', async () => {
    const input = fixture(),
      id = identity();
    const nativePrivateKey = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(id.privateKey.export({ format: 'der', type: 'pkcs8' })),
      'Ed25519',
      false,
      ['sign']
    );
    input.signer = read(P.nativeDeviceSigner(id.publicKey, nativePrivateKey));
    const derived: Crypto.ContentKey[] = [];
    const realDerive = Crypto.deriveContentKey;
    vi.spyOn(Crypto, 'deriveContentKey').mockImplementation((...args) => {
      const result = realDerive(...args);
      if (Result.isSuccess(result)) derived.push(result.success);
      return result;
    });
    let scratch: Uint8Array | undefined;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          vi.spyOn(globalThis.crypto.subtle, 'sign').mockImplementation(
            async (_algorithm, _key, message) => {
              scratch = message as Uint8Array;
              Deferred.doneUnsafe(entered, Effect.void);
              await Effect.runPromise(Deferred.await(release));
              return id.signBytes(scratch).buffer as ArrayBuffer;
            }
          );
          const fiber = yield* Effect.forkChild(P.sealRpcResponseContent(input));
          yield* Deferred.await(entered);
          fiber.interruptUnsafe();
          expect(fiber.pollUnsafe()).toBeUndefined();
          expect(scratch!.some((n) => n !== 0)).toBe(true);
          yield* Deferred.succeed(release, undefined);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          expect(scratch!.every((n) => n === 0)).toBe(true);
          expect(
            code(
              Crypto.sealContentAead(
                derived[0]!,
                { ...scope, purpose: 'rpc-response', docEpoch: 0, device: vector.publicKey },
                new Uint8Array()
              )
            )
          ).toBe('invalid-content-key');
          expect(hex(copyEpochKeyBytes(input.epochKey))).toBe(vector.epochKey);
        })
      )
    );
  });
});
