import { hashes, Point, verify } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { Result } from 'effect';
import { signature, signingPublicKey, type SigningPublicKey } from './bytes';
import { ContentError, ValidationError } from './errors';
import {
  contentSigningBytes,
  parseContentFrame,
  type ContentMetadata,
  type ContentScope,
} from './content-format';

// The pinned noble v3 synchronous API requires an explicit SHA-512 backend.
hashes.sha512 = sha512;

/** Canonical nonzero prime-subgroup A; canonical prime-subgroup R; S < L. */
export function verifySignature(
  publicKey: unknown,
  message: Uint8Array,
  signatureBytes: unknown
): Result.Result<void, ValidationError> {
  return Result.gen(function* () {
    const key = yield* signingPublicKey(publicKey);
    const sig = (yield* signature(signatureBytes)).toBytes();
    const valid = Result.try({
      try: () =>
        Point.fromBytes(sig.subarray(0, 32), false).isTorsionFree() &&
        verify(sig, message, key.toBytes(), { zip215: false }),
      catch: () => new ValidationError({ code: 'bad-signature' }),
    });
    if (!(yield* valid)) return yield* Result.fail(new ValidationError({ code: 'bad-signature' }));
    return undefined;
  });
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
  return Result.gen(function* () {
    const parsed = yield* parseContentFrame(frame);
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
