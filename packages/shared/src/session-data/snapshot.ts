import type { SessionId } from '../ids';
import type { SessionTurn } from './domain';
import type { SessionCommandResult } from './types';

// # Storage-owned snapshot capability
//
// Stored history is captured by the store itself, never by a caller-supplied
// "trusted" array. `capture()` issues an opaque, branded `SessionSnapshot`; the
// brand is not exported, so no JSON value or plain object can satisfy it at the
// type boundary, and at runtime authenticity is a registry lookup, not a shape
// check. Business callers pass only a selection (plus the handle) to
// `copyFrom`; they never pass the stored payload. `read()` is the handle's own
// full, detached read of the captured stored history — export/replay/hash
// consumers use it instead of stitching paginated reader calls.
//
// A handle is scoped to its issuing store and session: only that store can
// `release` it (idempotently), a handle issued by another store's `release`
// throws `cross_store`, a never-issued shape throws `invalid_snapshot`, and
// once the issuing store closes every outstanding handle reports
// `source_closed`. `copyFrom` additionally admits same-backend cross-store
// handles (the fork flow copies a source snapshot into a target doc), while a
// backend that cannot perform stored copy declares `capabilities.copy = false`
// and returns `rejected('unsupported')` instead of pretending.

declare const sessionSnapshotBrand: unique symbol;

/**
 * An opaque capability issued by one session store's snapshot service. It is
 * never constructible from JSON or plain objects: the brand symbol is not
 * exported and each store only honours handles minted by a store of its own
 * backend. `read()` is part of the capability: a released or closed-source
 * handle refuses to read.
 */
export interface SessionSnapshot {
  readonly [sessionSnapshotBrand]: true;
  /** The issuing store's session id, for caller-side scoping/preconditions. */
  readonly sessionId: SessionId;
  /**
   * One consistent, detached full read of the captured stored history. Throws
   * `SessionSnapshotError('released' | 'source_closed')` once the handle's
   * capability is gone.
   */
  read(): readonly SessionTurn[];
}

export type SessionSnapshotErrorCode =
  | 'invalid_snapshot'
  | 'released'
  | 'unsupported'
  | 'source_closed'
  | 'cross_store';

export class SessionSnapshotError extends Error {
  constructor(
    readonly code: SessionSnapshotErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SessionSnapshotError';
  }
}

/**
 * One store's stored-history snapshot service. Every handle it issues is bound
 * to the issuing store's identity and session id; the issuing store owns the
 * lifecycle of both the capture and the copy.
 */
export interface SessionSnapshotService {
  readonly capabilities: { readonly copy: boolean };
  /** One consistent capture of the store's stored history. */
  capture(): SessionSnapshot;
  /** Invalidate a handle. Idempotent for this store's already-released handles. */
  release(snapshot: SessionSnapshot): void;
  /**
   * Copy the business-authored `selection` into this store, using the captured
   * stored history as the provenance for unchanged opaque content. Returns
   * `rejected('unsupported')` when `capabilities.copy` is false; forged,
   * released or closed-source handles throw `SessionSnapshotError`, and a
   * handle from a different backend throws `cross_store`. A copy-capable
   * backend admits handles captured by another store of the same backend (the
   * fork flow).
   */
  copyFrom(snapshot: SessionSnapshot, selection: readonly SessionTurn[]): SessionCommandResult;
}

export type SessionSnapshotBackend = 'loro' | 'memory';

/**
 * Internal issuer record: the issuing store's identity token and backend kind
 * for cross-store validation, this capture's opaque payload (writer provenance
 * for Loro, a detached turn array for memory), the issuing store's live-handle
 * set and its source-closure state.
 */
export interface SessionSnapshotIssuerContext {
  /** The issuing store's identity; shared by every capture it mints. */
  readonly token: object;
  readonly backend: SessionSnapshotBackend;
  /** This capture's payload; valid only while the store owns the handle. */
  readonly payload: unknown;
  readonly issued: WeakSet<object>;
  readonly isClosed: () => boolean;
}

// Every minted handle records its issuing store. The mapping is keyed on the
// object itself and is never serialized, so a caller-shaped object is not a
// capability even if it copies the visible fields.
const issuedByStore = new WeakMap<object, SessionSnapshotIssuerContext>();

/** Internal minting for adapters; not part of the public surface. */
export function mintSessionSnapshot(
  context: SessionSnapshotIssuerContext,
  sessionId: SessionId,
  read: () => readonly SessionTurn[]
): SessionSnapshot {
  const snapshot = Object.freeze({ sessionId, read }) as unknown as SessionSnapshot;
  issuedByStore.set(snapshot, context);
  return snapshot;
}

/** Internal: the issuing store context of a handle, or undefined for a forgery. */
export function sessionSnapshotContext(snapshot: unknown): SessionSnapshotIssuerContext | undefined {
  return snapshot !== null && typeof snapshot === 'object'
    ? issuedByStore.get(snapshot)
    : undefined;
}

/**
 * Internal shared validation for scoped operations on the issuing store's own
 * service: source closure, authenticity, scope and liveness, in that order.
 */
export function checkSessionSnapshot(
  snapshot: SessionSnapshot,
  token: object,
  sourceClosed: boolean
): void {
  if (sourceClosed)
    throw new SessionSnapshotError('source_closed', 'The snapshot source store is closed.');
  const issuer = sessionSnapshotContext(snapshot);
  if (issuer === undefined)
    throw new SessionSnapshotError('invalid_snapshot', 'Not a snapshot capability of any store.');
  if (issuer.token !== token)
    throw new SessionSnapshotError('cross_store', 'The snapshot was issued by a different store.');
  if (!issuer.issued.has(snapshot))
    throw new SessionSnapshotError('released', 'The snapshot was released.');
}
