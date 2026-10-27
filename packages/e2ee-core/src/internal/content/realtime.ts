import { Effect, Result } from 'effect';
import * as Bytes from '../foundation/bytes';
import { ContentError } from '../foundation/errors';
import { concat } from '../foundation/concat';
import { keyId } from '../foundation/identifiers';
import {
  contentSigningBytes,
  copyContentAdditionalData,
  encodeContentContext,
  encodeContentHeader,
  MAX_CONTENT_BYTES,
  parseContentFrame,
  type ContentHeader,
  type ContentScope,
  type DocumentScope,
} from '../foundation/content-format';
import {
  deriveContentKey,
  disposeContentKey,
  openContentAead,
  sealContentAead,
} from '../crypto/content';
import { signVerified, type DeviceSigner } from '../foundation/signing';
import { verifyParsedContentSignature } from '../foundation/signature';

type RealtimePurpose = 'presence' | 'rpc-request' | 'rpc-response';
type SealInput = {
  readonly scope: DocumentScope;
  readonly epochKey: Bytes.EpochKey;
  readonly signer: DeviceSigner;
  readonly plaintext: Uint8Array;
  readonly additionalData?: Uint8Array;
};
type OpenInput = {
  readonly scope: DocumentScope;
  readonly epochKey: Bytes.EpochKey;
  readonly expectedSigner: Bytes.SigningPublicKey;
  readonly frame: Uint8Array;
  readonly additionalData?: Uint8Array;
};
const fail = (code: string) => Result.fail(new ContentError({ code }));

function seal(input: SealInput, purpose: RealtimePurpose): Effect.Effect<Uint8Array, ContentError> {
  return Effect.suspend(() => {
    const captured = Result.gen(function* () {
      const scope: ContentScope = Object.freeze({ ...input.scope, purpose });
      yield* encodeContentContext(scope);
      const source = input.plaintext;
      if (!(source instanceof Uint8Array)) return yield* fail('invalid-content-plaintext');
      if (source.byteLength > MAX_CONTENT_BYTES) return yield* fail('content-too-large');
      const binding = yield* copyContentAdditionalData(input.additionalData);
      const borrowed = input.signer;
      const signer = yield* Result.try({
        try: () => {
          const publicKey = Result.getOrThrow(Bytes.signingPublicKey(borrowed.publicKey.toBytes()));
          return Object.freeze({ publicKey, sign: borrowed.sign.bind(borrowed) });
        },
        catch: () => new ContentError({ code: 'invalid-signing-key' }),
      });
      return { scope, source, binding, signer, epochKey: input.epochKey };
    });
    return Effect.fromResult(captured).pipe(
      Effect.flatMap(({ scope, source, binding, signer, epochKey }) =>
        Effect.acquireUseRelease(
          Effect.suspend(() => Effect.fromResult(deriveContentKey(epochKey, scope))),
          (key) =>
            Effect.acquireUseRelease(
              Effect.sync(() => new Uint8Array(source)),
              (plaintext) =>
                Effect.gen(function* () {
                  const header: ContentHeader = {
                    ...scope,
                    docEpoch: 0,
                    device: keyId(signer.publicKey.toBytes()),
                  };
                  const prefix = yield* Effect.fromResult(encodeContentHeader(header));
                  const sealed = yield* Effect.fromResult(
                    sealContentAead(key, header, plaintext, binding)
                  );
                  plaintext.fill(0);
                  const unsigned = concat([prefix, sealed.nonce, sealed.ciphertext]);
                  const message = yield* Effect.fromResult(
                    contentSigningBytes(scope, unsigned, binding)
                  );
                  const signature = yield* signVerified(signer, message).pipe(
                    Effect.mapError((error) =>
                      error instanceof ContentError
                        ? error
                        : new ContentError({ code: 'invalid-signing-key' })
                    )
                  );
                  return concat([unsigned, signature.toBytes()]);
                }),
              (plaintext) => Effect.sync(() => plaintext.fill(0))
            ),
          (key) => Effect.sync(() => disposeContentKey(key))
        )
      )
    );
  });
}

function open(input: OpenInput, purpose: RealtimePurpose): Result.Result<Uint8Array, ContentError> {
  return Result.gen(function* () {
    const scope: ContentScope = Object.freeze({ ...input.scope, purpose });
    yield* encodeContentContext(scope);
    const binding = yield* copyContentAdditionalData(input.additionalData);
    const parsed = yield* parseContentFrame(input.frame, purpose);
    const signer = yield* Result.try({
      try: () => Result.getOrThrow(Bytes.signingPublicKey(input.expectedSigner.toBytes())),
      catch: () => new ContentError({ code: 'invalid-signing-key' }),
    });
    yield* verifyParsedContentSignature(parsed, scope, signer, binding);
    const key = yield* deriveContentKey(input.epochKey, scope);
    // Result.gen does not close a short-circuited iterator. Release in this
    // ordinary call before yielding its Result, including authentication failure.
    const opened = (() => {
      try {
        return openContentAead(
          key,
          { ...scope, docEpoch: 0, device: parsed.header.device },
          parsed.nonce,
          parsed.ciphertext,
          binding
        );
      } finally {
        disposeContentKey(key);
      }
    })();
    return yield* opened;
  });
}

/** Seal opaque bytes with the existing content-v0 presence purpose (7).
 * Inert until run; captures inputs before async signing, borrows the epoch key
 * and signer, and wipes owned plaintext and derived key on every exit. Retain
 * returned original bytes for retries. This primitive defines no presence body,
 * room binding, TTL, permission or approved realtime semantic profile. */
export function sealPresenceContent(input: SealInput): Effect.Effect<Uint8Array, ContentError> {
  return seal(input, 'presence');
}
/** Verify the independently trusted signer before deriving/decrypting purpose 7.
 * Returns owned plaintext for the caller to wipe, or a typed ContentError.
 * The caller establishes scope, epoch installation, permission and freshness;
 * cryptographic success supplies none of those authority decisions. */
export function openPresenceContent(input: OpenInput): Result.Result<Uint8Array, ContentError> {
  return open(input, 'presence');
}
/** Seal opaque bytes with the existing content-v0 RPC-request purpose (8).
 * Inert until run; borrows the epoch key/signer and releases owned plaintext and
 * derived key on every exit. Retain original bytes for retries. No RPC body,
 * target-machine mapping, authorization, freshness or deduplication is defined. */
export function sealRpcRequestContent(input: SealInput): Effect.Effect<Uint8Array, ContentError> {
  return seal(input, 'rpc-request');
}
/** Strictly verify the independently trusted signer before purpose-8 decryption.
 * The caller wipes returned owned plaintext and independently establishes scope,
 * installed epoch, machine binding, permission and freshness. Typed failures do
 * not authorize retrying an execution or changing the original frame. */
export function openRpcRequestContent(input: OpenInput): Result.Result<Uint8Array, ContentError> {
  return open(input, 'rpc-request');
}
/** Seal opaque bytes with the existing content-v0 RPC-response purpose (9).
 * Inert until run; borrows the epoch key/signer and releases owned plaintext and
 * derived key on every exit. Retain original bytes for retries. Request digest,
 * progress/result/error encoding and target-device authority remain caller work. */
export function sealRpcResponseContent(input: SealInput): Effect.Effect<Uint8Array, ContentError> {
  return seal(input, 'rpc-response');
}
/** Strictly verify the independently trusted signer before purpose-9 decryption.
 * Returns caller-owned plaintext to wipe or a typed ContentError. Caller trust
 * must establish the original target's signer, scope, epoch, request binding and
 * permission; holding the same epoch key does not satisfy expectedSigner. */
export function openRpcResponseContent(input: OpenInput): Result.Result<Uint8Array, ContentError> {
  return open(input, 'rpc-response');
}
