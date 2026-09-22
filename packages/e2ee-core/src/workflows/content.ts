import { Effect, Either } from 'effect';
import { ContentAuthority, ContentCrypto } from '../ports/content';
import {
  assembleContentFrame,
  assembleUnsignedContent,
  checkContentSigningKey,
  contentScopeBinding,
  contentSigningBytes,
  copyContentKey,
  decryptContent,
  encodeContentHeader,
  encryptContent,
  hexBytes,
  parseContentFrame,
  type SealContent,
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
  const snapshotKey = copyContentKey(input.epochKey);
  const snapshotPlain =
    input.plaintext instanceof Uint8Array ? copyBytes(input.plaintext) : new Uint8Array();
  const signingKey = input.signingKey;
  const scope = { ...input.scope };
  const author = { ...input.author };
  return Effect.acquireUseRelease(
    Effect.sync(() => ({
      plaintext: copyBytes(snapshotPlain),
      epochKey: Either.map(snapshotKey, copyBytes),
    })),
    ({ plaintext, epochKey: epochKeyCopy }) =>
      Effect.gen(function* () {
        if (oversized) return yield* Effect.fail(oversized);
        const epochKey = yield* epochKeyCopy;
        const contentCrypto = yield* ContentCrypto;
        const authority = yield* ContentAuthority;
        const messageId = hexBytes(yield* contentCrypto.random(16));
        const header = Object.freeze({
          genesis: scope.genesis,
          epoch: scope.epoch,
          resource: scope.resource,
          purpose: scope.purpose,
          actor: author.actor,
          memberInstance: author.memberInstance,
          device: author.device,
          messageId,
        });
        const aad = yield* encodeContentHeader(header);
        const publicKey = yield* authority.authorize(header);
        yield* checkContentSigningKey(publicKey);
        const nonce = yield* contentCrypto.random(24);
        const key = yield* contentCrypto.derive(epochKey, header);
        try {
          const ciphertext = yield* encryptContent(key, nonce, aad, plaintext);
          const unsigned = assembleUnsignedContent(aad, nonce, ciphertext);
          const message = contentSigningBytes(unsigned);
          const signature = yield* contentCrypto.sign(signingKey, message);
          const ok = yield* contentCrypto.verify(publicKey, message, hexBytes(signature));
          if (!ok) return yield* Effect.fail(new ContentError({ code: 'bad-content-signature' }));
          yield* authority.authorize(header, publicKey);
          return assembleContentFrame(unsigned, signature);
        } finally {
          key.fill(0);
        }
      }),
    ({ plaintext, epochKey: epochKeyCopy }) =>
      Effect.sync(() => {
        plaintext.fill(0);
        if (Either.isRight(epochKeyCopy)) epochKeyCopy.right.fill(0);
      })
  ).pipe(Effect.withSpan('e2ee.content.seal'));
}

export function authenticateContent(frame: Uint8Array) {
  const snapshot = copyBytes(frame);
  return Effect.gen(function* () {
    const parsed = yield* parseContentFrame(snapshot);
    const authority = yield* ContentAuthority;
    const contentCrypto = yield* ContentCrypto;
    const publicKey = yield* authority.authorize(parsed.header);
    yield* checkContentSigningKey(publicKey);
    const ok = yield* contentCrypto.verify(
      publicKey,
      contentSigningBytes(parsed.unsigned),
      parsed.signatureHex
    );
    if (!ok) return yield* Effect.fail(new ContentError({ code: 'bad-content-signature' }));
    yield* authority.authorize(parsed.header, publicKey);
    return parsed.header;
  }).pipe(Effect.withSpan('e2ee.content.authenticate'));
}

export function openContent(scope: ContentScopeInput, epochKey: Uint8Array, frame: Uint8Array) {
  const expectedScope = { ...scope };
  const snapshotFrame = copyBytes(frame);
  const snapshotKey = copyContentKey(epochKey);
  return Effect.acquireUseRelease(
    Effect.sync(() => ({ epochKey: Either.map(snapshotKey, copyBytes) })),
    ({ epochKey: epochKeyCopy }) =>
      Effect.gen(function* () {
        const expected = yield* contentScopeBinding(expectedScope);
        const parsed = yield* parseContentFrame(snapshotFrame);
        const actual = yield* contentScopeBinding(parsed.header);
        if (actual !== expected)
          return yield* Effect.fail(new ContentError({ code: 'content-context-mismatch' }));
        const copied = yield* epochKeyCopy;
        const authority = yield* ContentAuthority;
        const contentCrypto = yield* ContentCrypto;
        const publicKey = yield* authority.authorize(parsed.header);
        yield* checkContentSigningKey(publicKey);
        const ok = yield* contentCrypto.verify(
          publicKey,
          contentSigningBytes(parsed.unsigned),
          parsed.signatureHex
        );
        if (!ok) return yield* Effect.fail(new ContentError({ code: 'bad-content-signature' }));
        const key = yield* contentCrypto.derive(copied, parsed.header);
        try {
          yield* authority.authorize(parsed.header, publicKey);
          const plaintext = yield* decryptContent(key, parsed.nonce, parsed.aad, parsed.ciphertext);
          return { header: parsed.header, plaintext };
        } finally {
          key.fill(0);
        }
      }),
    ({ epochKey: epochKeyCopy }) =>
      Effect.sync(() => {
        if (Either.isRight(epochKeyCopy)) epochKeyCopy.right.fill(0);
      })
  ).pipe(Effect.withSpan('e2ee.content.open'));
}

type ContentScopeInput = {
  readonly genesis: string;
  readonly epoch: number;
  readonly resource: string;
  readonly purpose: SealContent['scope']['purpose'];
};
