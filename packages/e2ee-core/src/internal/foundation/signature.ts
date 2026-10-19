import { hashes, Point, verify } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { Data, Effect, Result } from 'effect';
import { signature, signingPublicKey, type SigningPublicKey } from './bytes';
import { ContentError, ValidationError } from './errors';
import { keyId } from './identifiers';
import {
  contentSigningBytes,
  parseContentFrame,
  type ContentMetadata,
  type ParsedContentFrame,
  type ContentScope,
} from './content-format';

// The pinned noble v3 synchronous API requires an explicit SHA-512 backend.
hashes.sha512 = sha512;

/** Internal fixed-backend failure; never a claim that a signature is invalid. */
export class NativeSignatureError extends Data.TaggedError('NativeSignatureError')<{
  readonly code: 'native-unavailable';
}> {}

const VERIFIED_SIGNATURE_CACHE_LIMIT = 256;
const MAX_CACHED_MESSAGE_BYTES = 8192;
// Only the complete native strict-verification path can add exact successful tuples.
// This proves mathematics, never membership, permission, freshness or publication.
const verifiedSignatures = new Set<string>();
type OwnedVerification = {
  readonly key: Uint8Array<ArrayBuffer>;
  readonly sig: Uint8Array<ArrayBuffer>;
  readonly message: Uint8Array<ArrayBuffer>;
};
function captureVerification(publicKey: unknown, message: Uint8Array, signatureBytes: unknown) {
  return Result.gen(function* () {
    const key = yield* signingPublicKey(publicKey);
    const sig = yield* signature(signatureBytes);
    if (!(message instanceof Uint8Array))
      return yield* Result.fail(new ValidationError({ code: 'bad-signature' }));
    return { key: key.toBytes(), sig: sig.toBytes(), message: new Uint8Array(message) };
  });
}
const verificationId = (owned: OwnedVerification) =>
  owned.message.length <= MAX_CACHED_MESSAGE_BYTES
    ? keyId(owned.key) + keyId(owned.sig) + keyId(owned.message)
    : undefined;
function clearVerification(owned: OwnedVerification) {
  owned.key.fill(0);
  owned.sig.fill(0);
  owned.message.fill(0);
}
function strictSignature(sig: Uint8Array): Result.Result<void, ValidationError> {
  return Result.try({
    try: () => {
      let scalar = 0n;
      for (let i = 63; i >= 32; i--) scalar = (scalar << 8n) | BigInt(sig[i]!);
      const nonce = Point.fromBytes(sig.subarray(0, 32), false);
      // Native Ed25519 providers disagree on identity R. Reject it before either
      // backend so ledger acceptance never depends on the host crypto library.
      if (scalar >= Point.CURVE().n || nonce.is0() || !nonce.isTorsionFree())
        throw new ValidationError({ code: 'bad-signature' });
    },
    catch: () => new ValidationError({ code: 'bad-signature' }),
  });
}
function rememberVerification(id: string | undefined) {
  if (id === undefined || verifiedSignatures.has(id)) return;
  if (verifiedSignatures.size === VERIFIED_SIGNATURE_CACHE_LIMIT)
    verifiedSignatures.delete(verifiedSignatures.values().next().value!);
  verifiedSignatures.add(id);
}

/** Canonical nonzero prime-subgroup A and R; S < L. */
export function verifySignature(
  publicKey: unknown,
  message: Uint8Array,
  signatureBytes: unknown
): Result.Result<void, ValidationError> {
  return Result.flatMap(captureVerification(publicKey, message, signatureBytes), (owned) => {
    try {
      const id = verificationId(owned);
      if (id !== undefined && verifiedSignatures.has(id)) return Result.succeed(undefined);
      return Result.flatMap(strictSignature(owned.sig), () =>
        Result.try({
          try: () => {
            if (!verify(owned.sig, owned.message, owned.key, { zip215: false }))
              throw new ValidationError({ code: 'bad-signature' });
          },
          catch: () => new ValidationError({ code: 'bad-signature' }),
        })
      );
    } finally {
      clearVerification(owned);
    }
  });
}

/** Fixed WebCrypto only. Native settlement and scratch cleanup precede interruption. */
export function verifySignatureEffect(
  publicKey: unknown,
  message: Uint8Array,
  signatureBytes: unknown
): Effect.Effect<void, ValidationError | NativeSignatureError> {
  return Effect.acquireUseRelease(
    Effect.suspend(() =>
      Effect.fromResult(captureVerification(publicKey, message, signatureBytes))
    ),
    (owned) =>
      Effect.suspend(() => {
        const id = verificationId(owned);
        if (id !== undefined && verifiedSignatures.has(id)) return Effect.void;
        return Effect.fromResult(strictSignature(owned.sig)).pipe(
          Effect.andThen(
            Effect.uninterruptible(
              Effect.tryPromise({
                try: async () => {
                  const subtle = globalThis.crypto?.subtle;
                  if (!subtle) throw new NativeSignatureError({ code: 'native-unavailable' });
                  const importKey = subtle.importKey.bind(subtle),
                    verifyNative = subtle.verify.bind(subtle);
                  const key = await importKey('raw', owned.key, 'Ed25519', false, ['verify']);
                  if ((await verifyNative('Ed25519', key, owned.sig, owned.message)) !== true)
                    throw new ValidationError({ code: 'bad-signature' });
                  rememberVerification(id);
                },
                catch: (error) =>
                  error instanceof ValidationError || error instanceof NativeSignatureError
                    ? error
                    : new NativeSignatureError({ code: 'native-unavailable' }),
              })
            )
          )
        );
      }),
    (owned) => Effect.sync(() => clearVerification(owned))
  );
}

/** Checks signature/context only, never membership, publication permission or plaintext.
 * The caller supplies the pinned Org/document/purpose and an independently trusted key.
 */
export function verifyContentSignature(
  frame: Uint8Array,
  scope: ContentScope,
  expectedSigner: SigningPublicKey,
  additionalData?: Uint8Array
): Result.Result<ContentMetadata, ContentError> {
  return Result.flatMap(parseContentFrame(frame, scope.purpose), (parsed) =>
    verifyParsedContentSignature(parsed, scope, expectedSigner, additionalData)
  );
}

/** Internal owned-frame path; not exported by the package entrypoints. */
export function verifyParsedContentSignature(
  parsed: ParsedContentFrame,
  scope: ContentScope,
  expectedSigner: SigningPublicKey,
  additionalData?: Uint8Array
): Result.Result<ContentMetadata, ContentError> {
  return Result.gen(function* () {
    if (parsed.header.epoch !== scope.epoch)
      return yield* Result.fail(new ContentError({ code: 'content-scope-mismatch' }));
    const device = expectedSigner.toBytes();
    const claimed = parsed.unsigned.subarray(7, 39);
    if (!device.every((byte, i) => byte === claimed[i]))
      return yield* Result.fail(new ContentError({ code: 'content-signer-mismatch' }));
    const message = yield* contentSigningBytes(scope, parsed.unsigned, additionalData);
    const sig = Uint8Array.from(parsed.signatureHex.match(/../g)!, (byte) => parseInt(byte, 16));
    yield* Result.mapError(
      verifySignature(device, message, sig),
      () => new ContentError({ code: 'bad-content-signature' })
    );
    return parsed.header;
  });
}
