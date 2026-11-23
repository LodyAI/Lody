import { Effect, Result } from 'effect';
import type { EpochKey } from '../foundation/bytes';
import { ContentError } from '../foundation/errors';
import {
  deriveContentKey,
  disposeContentKey,
  importContentKey,
  exportContentKey,
  type ContentKey,
} from '../crypto/content';
import {
  encodeDocumentContext,
  isDocumentPurpose,
  type DocumentScope,
  type ContentScope,
} from '../foundation/content-format';

declare const documentKey: unique symbol;
/** An opaque document key bound to genesis, resource, epoch and document generation 0. Only this module creates one; dispose it with `disposeDocumentKey`. */
export interface DocumentKey {
  readonly [documentKey]: true;
}
const keys = new WeakMap<DocumentKey, { key: ContentKey; scope: Readonly<DocumentScope> }>();
const leafScope = (scope: DocumentScope): ContentScope => ({ ...scope, purpose: 'doc-update' });
function own(scope: DocumentScope, key: ContentKey): DocumentKey {
  const value = Object.freeze({}) as DocumentKey;
  keys.set(value, { key, scope: Object.freeze({ ...scope, docEpoch: 0 }) });
  return value;
}
/** Release only this owned leaf capability, not a borrowed epoch key. */
export function disposeDocumentKey(key: DocumentKey): void {
  const row = keys.get(key);
  if (row) {
    disposeContentKey(row.key);
    keys.delete(key);
  }
}
/** Scope owns one independently derived leaf, with no runtime or native key custody. */
export function scopedDocumentKey(scope: DocumentScope, epochKey: EpochKey) {
  const ownedScope = { ...scope };
  return Effect.acquireRelease(
    Effect.suspend(() => Effect.fromResult(deriveDocumentKey(ownedScope, epochKey))),
    (key) => Effect.sync(() => disposeDocumentKey(key))
  );
}
/** Derive the document key of `scope` from an installed epoch key (HKDF, document leaf). The caller must have validated the epoch key; derivation grants no authority. */
export function deriveDocumentKey(scope: DocumentScope, epochKey: EpochKey) {
  return Result.map(deriveContentKey(epochKey, leafScope(scope)), (key) => own(scope, key));
}
/** Import document key bytes for `scope` (a per-document grant received out of band). */
export function importDocumentKey(scope: DocumentScope, bytes: Uint8Array) {
  return Result.map(importContentKey(bytes, leafScope(scope)), (key) => own(scope, key));
}
/** Copy a document key's bytes out, for an explicit per-document grant. Grants no authority by itself. */
export function exportDocumentKey(key: DocumentKey) {
  const row = keys.get(key);
  return row
    ? exportContentKey(row.key, leafScope(row.scope))
    : Result.fail(new ContentError({ code: 'invalid-document-key' }));
}
/** Internal lookup: purpose restrictions and every document context field are bound. */
export function documentKeyForScope(
  key: DocumentKey,
  scope: ContentScope
): Result.Result<ContentKey, ContentError> {
  return Result.gen(function* () {
    yield* encodeDocumentContext(scope);
    if (!isDocumentPurpose(scope.purpose))
      return yield* Result.fail(new ContentError({ code: 'invalid-document-purpose' }));
    const row = keys.get(key);
    if (!row) return yield* Result.fail(new ContentError({ code: 'invalid-document-key' }));
    if (
      row.scope.genesis !== scope.genesis ||
      row.scope.resource !== scope.resource ||
      row.scope.epoch !== scope.epoch ||
      (scope.docEpoch ?? 0) !== 0
    )
      return yield* Result.fail(new ContentError({ code: 'document-key-scope-mismatch' }));
    return row.key;
  });
}
