import { Effect, Layer } from 'effect';
import { SignatureVerifier } from '../ports/ledger';
import { ValidationError } from '../pure/errors';
import { SigningPointCache, verifySignature } from '../ledger/crypto';

/** Temporary protocol adapter. Cache allocation belongs to Layer acquisition,
 * never workflow construction or a shared live default. */
export function makeSignatureVerifier() {
  const cache = new SigningPointCache();
  return SignatureVerifier.of({
    verify: ({ publicKey, message, signature }) => {
      const ownedMessage = new Uint8Array(message);
      return Effect.suspend(() =>
        verifySignature(publicKey.toBytes(), ownedMessage, signature.toBytes(), cache)
          ? Effect.void
          : Effect.fail(new ValidationError({ code: 'bad-signature' }))
      );
    },
    verifyMany: (jobs, facts) => {
      const owned = jobs.map((job) => ({
        ...job,
        publicKey: new Uint8Array(job.publicKey),
        message: new Uint8Array(job.message),
        signature: new Uint8Array(job.signature),
      }));
      return Effect.suspend(() => {
        for (const job of owned) {
          if (!verifySignature(job.publicKey, job.message, job.signature, cache, facts))
            return Effect.fail(
              new ValidationError({
                code: job.code ?? 'bad-signature',
                position: job.position,
              })
            );
        }
        return Effect.void;
      });
    },
  });
}

export const signatureVerifierLayer: Layer.Layer<SignatureVerifier> = Layer.sync(
  SignatureVerifier,
  makeSignatureVerifier
);
