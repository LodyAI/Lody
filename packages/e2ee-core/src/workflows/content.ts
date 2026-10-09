import { Effect, Result } from 'effect';
import { ContentAuthority, ContentCrypto } from '../ports/content';
import {
  assembleContentFrame,
  assembleUnsignedContent,
  checkContentSigningKey,
  contentAad,
  contentSigningBytes,
  copyContentKey,
  copyContentAdditionalData,
  decryptContent,
  encodeContentHeader,
  encryptContent,
  hexBytes,
  parseContentFrame,
  type SealContent,
  type ContentScope,
  type ContentHeader,
  CONTENT_PREFIX_BYTES,
  MAX_CONTENT_BYTES,
} from '../pure/content-frame';
import { copyBytes } from '../pure/cbor';
import { ContentError } from '../pure/errors';

function tooLarge(bytes: Uint8Array) {
  return !(bytes instanceof Uint8Array) || bytes.byteLength > MAX_CONTENT_BYTES
    ? new ContentError({ code: 'content-too-large' })
    : null;
}

/** Snapshot caller bytes at construction. Each run allocates working copies and wipes only those. */
export function sealContent(input: SealContent) {
  const oversized = tooLarge(input.plaintext);
  const capturedBinding = copyContentAdditionalData(input.additionalData);
  const snapshotKey = copyContentKey(input.epochKey);
  const snapshotPlain = !oversized ? copyBytes(input.plaintext) : new Uint8Array();
  const signingKey = input.signingKey;
  const scope = { ...input.scope };
  const author = { ...input.author };
  return Effect.acquireUseRelease(
    Effect.sync(() => ({
      plaintext: copyBytes(snapshotPlain),
      epochKey: Result.map(snapshotKey, copyBytes),
    })),
    ({ plaintext, epochKey: epochKeyCopy }) =>
      Effect.gen(function* () {
        if (oversized) return yield* Effect.fail(oversized);
        const binding = yield* Effect.fromResult(capturedBinding);
        const epochKey = yield* Effect.fromResult(epochKeyCopy);
        const contentCrypto = yield* ContentCrypto;
        const authority = yield* ContentAuthority;
        const header = Object.freeze({
          genesis: scope.genesis,
          epoch: scope.epoch,
          resource: scope.resource,
          purpose: scope.purpose,
          device: author.device,
        });
        const prefix = yield* Effect.fromResult(encodeContentHeader(header));
        const aad = yield* Effect.fromResult(contentAad(scope, prefix, binding));
        const publicKey = yield* authority.authorize(header);
        yield* Effect.fromResult(checkContentSigningKey(publicKey));
        if (publicKey !== header.device)
          return yield* Effect.fail(new ContentError({ code: 'content-authority-changed' }));
        const nonce = yield* contentCrypto.random(24);
        return yield* Effect.acquireUseRelease(
          contentCrypto.derive(epochKey, header),
          (key) =>
            Effect.gen(function* () {
              const ciphertext = yield* Effect.fromResult(
                encryptContent(key, nonce, aad, plaintext)
              );
              const unsigned = assembleUnsignedContent(prefix, nonce, ciphertext);
              const message = yield* Effect.fromResult(
                contentSigningBytes(scope, unsigned, binding)
              );
              const signature = yield* contentCrypto.sign(signingKey, message);
              const ok = yield* contentCrypto.verify(publicKey, message, hexBytes(signature));
              if (!ok)
                return yield* Effect.fail(new ContentError({ code: 'bad-content-signature' }));
              yield* authority.authorize(header, publicKey);
              return assembleContentFrame(unsigned, signature);
            }),
          (key) => Effect.sync(() => key.fill(0))
        );
      }),
    ({ plaintext, epochKey: epochKeyCopy }) =>
      Effect.sync(() => {
        plaintext.fill(0);
        if (Result.isSuccess(epochKeyCopy)) epochKeyCopy.success.fill(0);
      })
  ).pipe(Effect.withSpan('e2ee.content.seal'));
}

export function authenticateContent(
  scope: ContentScope,
  frame: Uint8Array,
  additionalData?: Uint8Array
) {
  const capturedBinding = copyContentAdditionalData(additionalData);
  const expectedScope = { ...scope };
  const snapshot = parseContentFrame(frame);
  return Effect.gen(function* () {
    const binding = yield* Effect.fromResult(capturedBinding);
    const parsed = yield* Effect.fromResult(snapshot);
    const header = yield* boundHeader(expectedScope, parsed.header);
    const authority = yield* ContentAuthority;
    const contentCrypto = yield* ContentCrypto;
    const publicKey = yield* authority.authorize(header);
    yield* Effect.fromResult(checkContentSigningKey(publicKey));
    if (publicKey !== header.device)
      return yield* Effect.fail(new ContentError({ code: 'content-authority-changed' }));
    const ok = yield* contentCrypto.verify(
      publicKey,
      yield* Effect.fromResult(contentSigningBytes(expectedScope, parsed.unsigned, binding)),
      parsed.signatureHex
    );
    if (!ok) return yield* Effect.fail(new ContentError({ code: 'bad-content-signature' }));
    yield* authority.authorize(header, publicKey);
    return header;
  }).pipe(Effect.withSpan('e2ee.content.authenticate'));
}

export function openContent(
  scope: ContentScopeInput,
  epochKey: Uint8Array,
  frame: Uint8Array,
  additionalData?: Uint8Array
) {
  const capturedBinding = copyContentAdditionalData(additionalData);
  const expectedScope = { ...scope };
  const snapshotFrame = parseContentFrame(frame);
  const snapshotKey = copyContentKey(epochKey);
  return Effect.acquireUseRelease(
    Effect.sync(() => ({ epochKey: Result.map(snapshotKey, copyBytes) })),
    ({ epochKey: epochKeyCopy }) =>
      Effect.gen(function* () {
        const binding = yield* Effect.fromResult(capturedBinding);
        const parsed = yield* Effect.fromResult(snapshotFrame);
        const header = yield* boundHeader(expectedScope, parsed.header);
        const aad = yield* Effect.fromResult(
          contentAad(expectedScope, parsed.unsigned.subarray(0, CONTENT_PREFIX_BYTES), binding)
        );
        const copied = yield* Effect.fromResult(epochKeyCopy);
        const authority = yield* ContentAuthority;
        const contentCrypto = yield* ContentCrypto;
        const publicKey = yield* authority.authorize(header);
        yield* Effect.fromResult(checkContentSigningKey(publicKey));
        if (publicKey !== header.device)
          return yield* Effect.fail(new ContentError({ code: 'content-authority-changed' }));
        const ok = yield* contentCrypto.verify(
          publicKey,
          yield* Effect.fromResult(contentSigningBytes(expectedScope, parsed.unsigned, binding)),
          parsed.signatureHex
        );
        if (!ok) return yield* Effect.fail(new ContentError({ code: 'bad-content-signature' }));
        return yield* Effect.acquireUseRelease(
          contentCrypto.derive(copied, header),
          (key) =>
            Effect.gen(function* () {
              yield* authority.authorize(header, publicKey);
              const plaintext = yield* Effect.fromResult(
                decryptContent(key, parsed.nonce, aad, parsed.ciphertext)
              );
              return { header, plaintext };
            }),
          (key) => Effect.sync(() => key.fill(0))
        );
      }),
    ({ epochKey: epochKeyCopy }) =>
      Effect.sync(() => {
        if (Result.isSuccess(epochKeyCopy)) epochKeyCopy.success.fill(0);
      })
  ).pipe(Effect.withSpan('e2ee.content.open'));
}

function boundHeader(scope: ContentScope, metadata: { epoch: number; device: string }) {
  if (scope.epoch !== metadata.epoch)
    return Effect.fail(new ContentError({ code: 'content-context-mismatch' }));
  const header: ContentHeader = Object.freeze({ ...scope, device: metadata.device });
  return Effect.as(Effect.fromResult(encodeContentHeader(header)), header);
}
type ContentScopeInput = ContentScope;
