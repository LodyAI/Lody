import { Effect, Result } from 'effect';
import * as Bytes from './bytes';
import { ContentError } from './errors';
import { NativeSignatureError, verifySignatureEffect } from './signature';
import { MAX_CONTENT_BYTES } from './content-format';
const bounded = (message: Uint8Array) =>
  message instanceof Uint8Array && message.byteLength <= MAX_CONTENT_BYTES + 4096;

/** Borrowed platform capability. Its owner controls native key lifetime and cancellation. */
export interface DeviceSigner {
  readonly publicKey: Bytes.SigningPublicKey;
  readonly sign: (message: Uint8Array) => Effect.Effect<Bytes.Signature, ContentError>;
}
/** Fixed verifier always checks signer output; an injected signer cannot grant authority. */
export function signVerified(signer: DeviceSigner, message: Uint8Array) {
  return Effect.suspend(() => {
    if (!bounded(message))
      return Effect.fail(new ContentError({ code: 'signing-message-too-large' }));
    const owned = new Uint8Array(message);
    return Effect.gen(function* () {
      const key = yield* Effect.fromResult(Bytes.signingPublicKey(signer.publicKey.toBytes()));
      const signed = yield* signer.sign(new Uint8Array(owned));
      const signature = yield* Effect.fromResult(Bytes.signature(signed.toBytes()));
      yield* verifySignatureEffect(key.toBytes(), owned, signature.toBytes()).pipe(
        Effect.mapError(
          (error) =>
            new ContentError({
              code: error instanceof NativeSignatureError ? 'native-unavailable' : 'bad-signature',
            })
        )
      );
      return signature;
    });
  });
}
/** No generation/export/storage. Non-cancellable WebCrypto completion is awaited. */
export function nativeDeviceSigner(
  publicKey: Bytes.SigningPublicKey,
  privateKey: CryptoKey
): Result.Result<DeviceSigner, ContentError> {
  return Result.gen(function* () {
    const key = yield* Result.mapError(
      Bytes.signingPublicKey(publicKey.toBytes()),
      () => new ContentError({ code: 'invalid-signing-key' })
    );
    if (
      privateKey?.type !== 'private' ||
      privateKey.algorithm.name !== 'Ed25519' ||
      !privateKey.usages.includes('sign')
    )
      return yield* Result.fail(new ContentError({ code: 'invalid-signing-key' }));
    return Object.freeze({
      publicKey: key,
      sign: (message: Uint8Array) =>
        Effect.suspend(() => {
          if (!bounded(message))
            return Effect.fail(new ContentError({ code: 'signing-message-too-large' }));
          const bytes = new Uint8Array(message);
          return Effect.uninterruptible(
            Effect.tryPromise({
              try: async () => {
                try {
                  const signature = await globalThis.crypto.subtle.sign(
                    'Ed25519',
                    privateKey,
                    bytes
                  );
                  return Result.getOrThrow(Bytes.signature(new Uint8Array(signature)));
                } finally {
                  bytes.fill(0);
                }
              },
              catch: () => new ContentError({ code: 'sign-failed' }),
            })
          );
        }),
    });
  });
}
