import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { Data, Effect, Result } from 'effect';
import * as Bytes from '../bytes';
import { encodeCbor } from '../cbor';
import { copyEpochKeyBytes } from '../epoch-key';
import { ValidationError } from '../errors';

export class HpkePrimitiveError extends Data.TaggedError('HpkePrimitiveError')<{
  readonly code:
    | 'random-unavailable'
    | 'invalid-input'
    | 'recipient-mismatch'
    | 'seal-failed'
    | 'open-failed';
}> {}

/** Independently trusted caller context; never derive it from an envelope or URL. */
export interface EpochHpkeContext {
  readonly genesis: Bytes.GenesisHash;
  readonly epoch: Bytes.EpochNumber;
  readonly sender: Bytes.SigningPublicKey;
  readonly recipient: Bytes.SigningPublicKey;
}

/** Unsigned HPKE payload only, not an authorized or ready-to-deliver envelope. */
export interface SealedEpochHpke {
  readonly enc: Uint8Array;
  readonly ct: Uint8Array;
}

/** Preserve the existing ledger envelope's exact canonical AAD. */
export function epochHpkeAad(
  context: EpochHpkeContext
): Result.Result<Uint8Array, ValidationError> {
  return Result.flatMap(
    Result.try({
      try: () => ({
        genesis: context.genesis.toBytes(),
        epoch: context.epoch,
        sender: context.sender.toBytes(),
        recipient: context.recipient.toBytes(),
      }),
      catch: () => new ValidationError({ code: 'invalid-operation' }),
    }),
    (value) =>
      Result.gen(function* () {
        yield* Bytes.genesisHash(value.genesis);
        yield* Bytes.epochNumber(value.epoch);
        yield* Bytes.signingPublicKey(value.sender);
        yield* Bytes.signingPublicKey(value.recipient);
        return yield* encodeCbor([value.genesis, value.epoch, value.sender, value.recipient]);
      })
  );
}

function suite() {
  return new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
}
const info = () => new TextEncoder().encode('lody-e2ee/hpke-epoch/v1\0');
const error = (code: HpkePrimitiveError['code']) => new HpkePrimitiveError({ code });

function publicBytes(key: Bytes.EncryptionPublicKey) {
  return Result.flatMap(
    Result.try({ try: () => key.toBytes(), catch: () => error('invalid-input') }),
    (bytes) => Result.map(Bytes.encryptionPublicKey(bytes), (valid) => valid.toBytes())
  );
}

/** Base mode only. Does not sign, check a ledger, publish or install a key.
 * Every new seal requires host secure randomness; retries retain the exact payload.
 * Native crypto has no cancellation API: interruption waits for this one operation
 * and its temporary-buffer cleanup, without starting another runtime or fiber. */
export function sealEpochKeyHpke(
  recipientKey: Bytes.EncryptionPublicKey,
  key: Bytes.EpochKey,
  context: EpochHpkeContext
): Effect.Effect<SealedEpochHpke, HpkePrimitiveError | ValidationError> {
  return Effect.suspend(() => {
    const validated = Result.gen(function* () {
      const aad = yield* epochHpkeAad(context);
      const recipient = yield* publicBytes(recipientKey);
      return { aad, recipient };
    });
    return Effect.flatMap(Effect.fromResult(validated), ({ aad, recipient }) =>
      Effect.uninterruptible(
        Effect.tryPromise({
          try: async () => {
            const ikm = new Uint8Array(32);
            let plaintext: Uint8Array | undefined;
            try {
              try {
                plaintext = copyEpochKeyBytes(key);
                if (plaintext.byteLength !== 32) throw error('invalid-input');
              } catch {
                throw error('invalid-input');
              }
              try {
                globalThis.crypto.getRandomValues(ikm);
              } catch {
                throw error('random-unavailable');
              }
              const cipher = suite();
              const recipientPublicKey = await cipher.kem.deserializePublicKey(recipient);
              const sealed = await cipher.seal(
                { recipientPublicKey, info: info(), ekm: ikm },
                plaintext,
                aad
              );
              if (sealed.enc.byteLength !== 32 || sealed.ct.byteLength !== 48)
                throw error('seal-failed');
              return { enc: new Uint8Array(sealed.enc), ct: new Uint8Array(sealed.ct) };
            } finally {
              plaintext?.fill(0);
              ikm.fill(0);
            }
          },
          catch: (cause) => (cause instanceof HpkePrimitiveError ? cause : error('seal-failed')),
        })
      )
    );
  });
}

/** Crypto only. Verify the outer signature, sender/recipient eligibility and key
 * commitment separately before installation or use. Successful Base decryption
 * does not authenticate a sender. The caller owns the device CryptoKeyPair's lifetime;
 * this operation neither generates, exports, stores nor retains its private handle. */
export function openEpochKeyHpke(
  pair: CryptoKeyPair,
  expectedRecipientKey: Bytes.EncryptionPublicKey,
  context: EpochHpkeContext,
  payload: SealedEpochHpke
): Effect.Effect<Bytes.EpochKey, HpkePrimitiveError | ValidationError> {
  return Effect.suspend(() => {
    const validated = Result.gen(function* () {
      const aad = yield* epochHpkeAad(context);
      const recipient = yield* publicBytes(expectedRecipientKey);
      if (
        !(payload?.enc instanceof Uint8Array) ||
        payload.enc.byteLength !== 32 ||
        !(payload?.ct instanceof Uint8Array) ||
        payload.ct.byteLength !== 48 ||
        !pair?.publicKey ||
        !pair?.privateKey
      )
        return yield* Result.fail(error('invalid-input'));
      return {
        aad,
        recipient,
        enc: new Uint8Array(payload.enc),
        ct: new Uint8Array(payload.ct),
        keyPair: { publicKey: pair.publicKey, privateKey: pair.privateKey },
      };
    });
    return Effect.flatMap(Effect.fromResult(validated), ({ aad, recipient, enc, ct, keyPair }) =>
      Effect.uninterruptible(
        Effect.tryPromise({
          try: async () => {
            let plaintext: Uint8Array | undefined;
            try {
              const cipher = suite();
              const actual = new Uint8Array(await cipher.kem.serializePublicKey(keyPair.publicKey));
              if (actual.byteLength !== 32 || actual.some((byte, i) => byte !== recipient[i]))
                throw error('recipient-mismatch');
              plaintext = new Uint8Array(
                await cipher.open({ recipientKey: keyPair, enc, info: info() }, ct, aad)
              );
              if (plaintext.byteLength !== 32) throw error('open-failed');
              const result = Bytes.epochKey(plaintext);
              if (Result.isFailure(result)) throw error('open-failed');
              return result.success;
            } finally {
              plaintext?.fill(0);
            }
          },
          catch: (cause) => (cause instanceof HpkePrimitiveError ? cause : error('open-failed')),
        })
      )
    );
  });
}
