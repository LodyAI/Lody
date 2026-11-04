import { Schema } from 'effect';

/**
 * Failure of a local persistence service.
 *
 * `reason` is the only part callers should branch on:
 * - `storage`: the medium failed (I/O, lock timeout). Retrying may succeed.
 * - `corrupt`: stored data violates the store's format or bindings. Do not retry
 *   blindly; the store refuses to rewrite input it cannot verify.
 * - `closed`: the owning Scope has closed the store.
 * - `conflict`: a compare-and-set precondition failed (another writer won).
 * - `capacity`: a configured bound was reached; acknowledging results frees it.
 * - `missing`: the requested row does not exist.
 *
 * Stores never decide authority: callers re-verify everything they read
 * against the ledger, so a failing or lying store can only deny service.
 *
 * @category Errors
 */
export class LocalStoreError extends Schema.TaggedError<LocalStoreError>()('LocalStoreError', {
  /** Stable store name, for diagnostics only. */
  store: Schema.String,
  reason: Schema.Literals(['storage', 'corrupt', 'closed', 'conflict', 'capacity', 'missing']),
}) {}

/**
 * The remote ledger log could not complete a read or append.
 *
 * This is a transport outcome, not a verdict: after an append fails the record
 * may or may not have been committed, so callers reconcile by reading back the
 * original bytes rather than re-signing.
 *
 * @category Errors
 */
export class LedgerLogError extends Schema.TaggedError<LedgerLogError>()('LedgerLogError', {
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * The application could not supply its verified ledger view. Wrap an expected
 * feed, storage or transport failure in `cause`; defects and interruption stay
 * in Effect's Cause channel. This is an availability failure, not permission
 * or rollback evidence. `VerifiedLedger` reports it as `reason: 'source'`
 * without advancing its durable pin. Do not display the raw cause to users.
 *
 * @category Errors
 */
export class LedgerViewSourceError extends Schema.TaggedError<LedgerViewSourceError>()(
  'LedgerViewSourceError',
  { cause: Schema.optional(Schema.Defect()) }
) {}

/**
 * A backend (mailbox, staging, vault, invitation) request failed or was refused.
 *
 * Backends are untrusted for authority, so this error never carries a decision
 * the client must accept: the client keeps its originals and retries or reports.
 *
 * @category Errors
 */
export class BackendError extends Schema.TaggedError<BackendError>()('BackendError', {
  /** Which backend service failed, e.g. `KeyMailbox`. */
  service: Schema.String,
  /** `unauthorized` when the backend refused the authenticated principal. */
  reason: Schema.Literals(['unavailable', 'unauthorized', 'invalid-response', 'conflict']),
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * The platform key protector failed to seal or open local key material.
 *
 * @category Errors
 */
export class KeyProtectorError extends Schema.TaggedError<KeyProtectorError>()(
  'KeyProtectorError',
  { cause: Schema.optional(Schema.Defect()) }
) {}
