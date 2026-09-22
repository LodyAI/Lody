import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, HpkeError } from '@hpke/core';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { Effect, Layer } from 'effect';
import type { Entropy } from '../capabilities';
import { HpkeRecipient, HpkeSender } from '../ports/hpke';
import { CryptoEntropy } from '../ports/entropy';
import { encryptionPublicKey, epochKey } from '../pure/bytes';
import { copyEpochKeyBytes } from '../pure/epoch-key';
import { CryptoError, ValidationError } from '../pure/errors';

/** Single SDK boundary shared with temporary Promise consumers. No policy here. */
export function createHpkeDriver() {
  const suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
  const info = () => new TextEncoder().encode('lody-e2ee/hpke-epoch/v1\0');
  return {
    async seal(recipient: Uint8Array, key: Uint8Array, aad: Uint8Array, entropy?: Entropy) {
      const recipientBytes = new Uint8Array(recipient);
      const plaintext = new Uint8Array(key);
      const associated = new Uint8Array(aad);
      try {
        const recipientPublicKey = await suite.kem.deserializePublicKey(recipientBytes);
        return await suite.seal(
          {
            recipientPublicKey,
            info: info(),
            ...(entropy ? { ekm: entropy.fill('hpke-dhkem-ikm', new Uint8Array(32)) } : {}),
          },
          plaintext,
          associated
        );
      } finally {
        plaintext.fill(0);
      }
    },
    async publicKey(keyPair: CryptoKeyPair) {
      return new Uint8Array(await suite.kem.serializePublicKey(keyPair.publicKey));
    },
    async open(keyPair: CryptoKeyPair, enc: Uint8Array, ct: Uint8Array, aad: Uint8Array) {
      return new Uint8Array(
        await suite.open(
          { recipientKey: keyPair, enc: new Uint8Array(enc), info: info() },
          new Uint8Array(ct),
          new Uint8Array(aad)
        )
      );
    },
  };
}

function cryptoCall<A>(
  operation: 'seal' | 'open' | 'import',
  work: () => Promise<A>
): Effect.Effect<A, CryptoError> {
  return Effect.tryPromise({ try: work, catch: (error) => error }).pipe(
    Effect.catchAll((error) =>
      error instanceof HpkeError || error instanceof DOMException
        ? Effect.fail(new CryptoError({ operation }))
        : Effect.die(error)
    )
  );
}

/** Every native seal obtains entropy from the explicitly provided Service. */
export function hpkeSenderLayer(): Layer.Layer<HpkeSender, never, CryptoEntropy> {
  return Layer.effect(
    HpkeSender,
    Effect.gen(function* () {
      const entropy = yield* CryptoEntropy;
      const driver = createHpkeDriver();
      return HpkeSender.of({
        seal: ({ recipient, key, aad }) => {
          const associated = new Uint8Array(aad);
          return Effect.gen(function* () {
            const source = yield* entropy.bytes('hpke-dhkem-ikm', 32);
            if (source.byteLength !== 32)
              return yield* Effect.fail(new CryptoError({ operation: 'generate' }));
            const ikm = new Uint8Array(source);
            return yield* cryptoCall('seal', async () => {
              const plaintext = copyEpochKeyBytes(key);
              try {
                return await driver.seal(recipient.toBytes(), plaintext, associated, {
                  fill: (_label, target) => {
                    target.set(ikm);
                    return target;
                  },
                });
              } finally {
                plaintext.fill(0);
                ikm.fill(0);
              }
            });
          }).pipe(
            Effect.flatMap((sealed) =>
              sealed.enc.byteLength === 32 && sealed.ct.byteLength === 48
                ? Effect.succeed({ enc: new Uint8Array(sealed.enc), ct: new Uint8Array(sealed.ct) })
                : Effect.fail(new ValidationError({ code: 'invalid-operation' }))
            )
          );
        },
      });
    })
  );
}

export function hpkeRecipientLayer(
  pair: CryptoKeyPair
): Layer.Layer<HpkeRecipient, CryptoError | ValidationError> {
  const keyPair = { publicKey: pair.publicKey, privateKey: pair.privateKey };
  return Layer.effect(
    HpkeRecipient,
    Effect.gen(function* () {
      const driver = yield* Effect.sync(createHpkeDriver);
      const publicKey = yield* encryptionPublicKey(
        yield* cryptoCall('import', () => driver.publicKey(keyPair))
      );
      return HpkeRecipient.of({
        publicKey,
        open: ({ enc, ct, aad }) => {
          const encapsulated = new Uint8Array(enc),
            ciphertext = new Uint8Array(ct),
            associated = new Uint8Array(aad);
          return cryptoCall('open', () =>
            driver.open(keyPair, encapsulated, ciphertext, associated)
          ).pipe(
            Effect.flatMap((plaintext) => {
              try {
                return epochKey(plaintext);
              } finally {
                plaintext.fill(0);
              }
            })
          );
        },
      });
    })
  );
}
