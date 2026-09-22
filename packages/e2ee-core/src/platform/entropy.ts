import { Effect, Layer } from 'effect';
import { CryptoEntropy } from '../ports/entropy';
import { CryptoError } from '../pure/errors';

/** Opt-in production entropy. No randomness is consumed while composing Layers. */
export const cryptoEntropyLayer = Layer.succeed(CryptoEntropy, {
  bytes: (_label, length) =>
    Effect.try({
      try: () => {
        const bytes = new Uint8Array(length);
        // WebCrypto limits one call to 65,536 bytes.
        for (let offset = 0; offset < length; offset += 65_536)
          globalThis.crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
        return bytes;
      },
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) =>
        error instanceof DOMException
          ? Effect.fail(new CryptoError({ operation: 'generate' }))
          : Effect.die(error)
      )
    ),
});
