import { historicalContentIdentity } from '../ledger/snapshot';
import { Effect, Result } from 'effect';
import * as Bytes from '../foundation/bytes';
import { ContentError } from '../foundation/errors';
import { concat } from '../foundation/concat';
import { keyId } from '../foundation/identifiers';
import {
  contentPermissions,
  requireLedgerContinuation,
  epochHistoryPacket,
  type LedgerView,
} from '../ledger';
import {
  contentSigningBytes,
  encodeContentHeader,
  parseContentFrame,
  copyContentAdditionalData,
  isDocumentPurpose,
  MAX_CONTENT_BYTES,
  type ContentScope,
  type ContentHeader,
  type ParsedContentFrame,
} from '../foundation/content-format';
import { sealContentAead, openContentAead } from '../crypto/content';
import { verifyParsedContentSignature } from '../foundation/signature';
import { signVerified, type DeviceSigner } from '../foundation/signing';
import { documentKeyForScope, type DocumentKey } from './document-key';
export {
  deriveDocumentKey,
  disposeDocumentKey,
  scopedDocumentKey,
  importDocumentKey,
  exportDocumentKey,
  type DocumentKey,
} from './document-key';

const fail = (code: string) => Result.fail(new ContentError({ code }));
function boundAuthority(
  view: LedgerView,
  scope: ContentScope,
  signer: Bytes.SigningPublicKey,
  mode: 'authenticate' | 'admit' | 'seal'
) {
  return Result.gen(function* () {
    // Queries below also authenticate the view's runtime provenance.
    const epoch = yield* Result.mapError(
      epochHistoryPacket(view, scope.epoch),
      () => new ContentError({ code: 'unauthorized' })
    );
    if (keyId(view.genesis.toBytes()) !== scope.genesis)
      return yield* fail('content-context-mismatch');
    if (!isDocumentPurpose(scope.purpose)) return yield* fail('invalid-document-purpose');
    const author = yield* Result.mapError(
      historicalContentIdentity(view, signer),
      () => new ContentError({ code: 'unauthorized' })
    );
    if (mode !== 'authenticate') {
      const permissions = yield* Result.mapError(
        contentPermissions(view, signer),
        () => new ContentError({ code: 'unauthorized' })
      );
      const currentEpoch = view.inspectState().epoch.number;
      if (
        mode === 'seal'
          ? !permissions.maySealNewContent || epoch.epoch !== currentEpoch
          : !permissions.mayWriteDocument || epoch.epoch > currentEpoch
      )
        return yield* fail('unauthorized');
    }
    return author;
  });
}
/** Return signed bytes only; final host admission must independently check current permissions. */
export function sealDocument(input: {
  readonly scope: ContentScope;
  readonly documentKey: DocumentKey;
  readonly signer: DeviceSigner;
  /** Caller-owned synchronized genuine view lookup, with explicit full/endorsed provenance. */
  readonly ledger: () => Effect.Effect<LedgerView, ContentError>;
  readonly plaintext: Uint8Array;
  readonly additionalData?: Uint8Array;
  /** Required for snapshot purposes, forbidden for updates. */
  readonly continuationOffset?: string;
}) {
  return Effect.suspend(() =>
    Effect.gen(function* () {
      const scope = Object.freeze({ ...input.scope });
      const key = yield* Effect.fromResult(documentKeyForScope(input.documentKey, scope));
      const source = input.plaintext;
      if (!(source instanceof Uint8Array) || source.byteLength > MAX_CONTENT_BYTES)
        return yield* Effect.fail(new ContentError({ code: 'content-too-large' }));
      const binding = yield* Effect.fromResult(copyContentAdditionalData(input.additionalData));
      const borrowed = input.signer;
      const signer = yield* Effect.fromResult(Bytes.signingPublicKey(borrowed.publicKey.toBytes()));
      const capability: DeviceSigner = Object.freeze({
        publicKey: signer,
        sign: borrowed.sign.bind(borrowed),
      });
      const lookup = input.ledger;
      const continuationOffset = input.continuationOffset;
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => new Uint8Array(source)),
        (plaintext) =>
          Effect.gen(function* () {
            const view = yield* lookup();
            yield* Effect.fromResult(boundAuthority(view, scope, signer, 'seal'));
            const header: ContentHeader = {
              ...scope,
              docEpoch: 0,
              device: keyId(signer.toBytes()),
              ...(continuationOffset === undefined ? {} : { continuationOffset }),
            };
            const prefix = yield* Effect.fromResult(encodeContentHeader(header));
            const sealed = yield* Effect.fromResult(
              sealContentAead(key, header, plaintext, binding)
            );
            plaintext.fill(0);
            const unsigned = concat([prefix, sealed.nonce, sealed.ciphertext]);
            const message = yield* Effect.fromResult(contentSigningBytes(scope, unsigned, binding));
            const signature = yield* signVerified(capability, message);
            const frame = concat([unsigned, signature.toBytes()]);
            const latest = yield* lookup();
            yield* Effect.fromResult(
              Result.mapError(
                requireLedgerContinuation(view, latest),
                () => new ContentError({ code: 'unauthorized' })
              )
            );
            yield* Effect.fromResult(boundAuthority(latest, scope, signer, 'seal'));
            return frame;
          }),
        (plaintext) => Effect.sync(() => plaintext.fill(0))
      );
    })
  );
}
/** Authenticate admitted historical authors; this is neither host write admission nor decryption. */
export function authenticateDocument(
  view: LedgerView,
  scope: ContentScope,
  frame: Uint8Array,
  additionalData?: Uint8Array
) {
  return Result.flatMap(parseContentFrame(frame, scope.purpose), (parsed) =>
    authenticateParsed(view, scope, parsed, additionalData)
  );
}

function authenticateParsed(
  view: LedgerView,
  scope: ContentScope,
  parsed: ParsedContentFrame,
  additionalData?: Uint8Array
) {
  return Result.gen(function* () {
    const signer = yield* Result.mapError(
      Bytes.signingPublicKey(parsed.unsigned.subarray(7, 39)),
      () => new ContentError({ code: 'invalid-signing-key' })
    );
    const author = yield* boundAuthority(view, scope, signer, 'authenticate');
    const metadata = yield* verifyParsedContentSignature(parsed, scope, signer, additionalData);
    return Object.freeze({
      header: Object.freeze({
        ...scope,
        device: metadata.device,
        docEpoch: 0 as const,
        ...(metadata.continuationOffset === undefined
          ? {}
          : { continuationOffset: metadata.continuationOffset }),
      }),
      author,
    });
  });
}
/** Host upload admission, distinct from new sealing, historical authentication and AEAD open.
 * The caller selects current genuine view, exact scope and authenticated principal.
 * Admission proves signature/current writing permission, never valid plaintext. */
export function admitDocument(
  view: LedgerView,
  scope: ContentScope,
  frame: Uint8Array,
  authenticatedDevice: Bytes.SigningPublicKey,
  additionalData?: Uint8Array
) {
  return Result.gen(function* () {
    const principal = yield* Bytes.signingPublicKey(authenticatedDevice.toBytes());
    yield* boundAuthority(view, scope, principal, 'admit');
    const authenticated = yield* authenticateDocument(view, scope, frame, additionalData);
    if (authenticated.header.device !== keyId(principal.toBytes()))
      return yield* fail('unauthorized');
    return authenticated;
  });
}
/** Authenticate a sealed frame like `authenticateDocument`, then verify the AEAD and return the author and an owned plaintext buffer (the caller wipes it). */
export function openDocument(
  view: LedgerView,
  scope: ContentScope,
  documentKey: DocumentKey,
  frame: Uint8Array,
  additionalData?: Uint8Array
) {
  return Result.gen(function* () {
    const parsed = yield* parseContentFrame(frame, scope.purpose);
    const authenticated = yield* authenticateParsed(view, scope, parsed, additionalData);
    const key = yield* documentKeyForScope(documentKey, scope);
    const plaintext = yield* openContentAead(
      key,
      authenticated.header,
      parsed.nonce,
      parsed.ciphertext,
      additionalData
    );
    return { ...authenticated, plaintext };
  });
}
