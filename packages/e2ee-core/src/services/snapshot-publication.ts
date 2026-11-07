import { Context, Data, type Effect } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';

/** Failure of the reference snapshot publication journal; `code` names the reason. */
export class SnapshotPublicationError extends Data.TaggedError('SnapshotPublicationError')<{
  readonly code:
    | 'invalid-input'
    | 'closed'
    | 'storage'
    | 'corrupt'
    | 'conflict'
    | 'busy'
    | 'capacity';
}> {}
/** Exact snapshot offset, signer, digest and first credential window; no offset ordering or authority. */
export interface SnapshotPublicationIdentity {
  readonly offset: string;
  readonly signer: string;
  readonly digest: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
/** One stored snapshot publication: its identity, state (Pending, Accepted, current) and, while retained, its body. */
export type SnapshotPublicationRow = SnapshotPublicationIdentity &
  (
    | { readonly phase: 'Pending'; readonly body: Uint8Array }
    | { readonly phase: 'Accepted'; readonly body: Uint8Array | null }
  );
/** Exact ciphertext and credential window retained before native publication. */
export type SnapshotPublicationOriginal = Omit<SnapshotPublicationIdentity, 'digest'> & {
  readonly body: Uint8Array;
};

/** SHA-256 identity of an original snapshot body; never proves its publisher or native acceptance. */
export const snapshotPublicationDigest = (body: Uint8Array) =>
  Array.from(sha256(body), (x) => x.toString(16).padStart(2, '0')).join('');
/** Local snapshot publication journal. A Pending original blocks new writes; accepted historical retries cannot rewind current. The host owns serialized native publication and exact readback. */
export class SnapshotPublicationJournal extends Context.Service<
  SnapshotPublicationJournal,
  {
    /** Retained original/receipt at an exact opaque offset. */
    lookup(offset: string): Effect.Effect<SnapshotPublicationRow | null, SnapshotPublicationError>;
    /** The unresolved original, never an instruction to reseal. */
    pending(): Effect.Effect<SnapshotPublicationRow | null, SnapshotPublicationError>;
    /** The retained current Accepted body; metadata alone is insufficient. */
    current(): Effect.Effect<
      (SnapshotPublicationRow & { readonly body: Uint8Array }) | null,
      SnapshotPublicationError
    >;
    /** Retain first offset/signer/digest and credential window before native PUT; exact retries keep the first original. */
    reserve(
      original: SnapshotPublicationOriginal
    ): Effect.Effect<SnapshotPublicationRow, SnapshotPublicationError>;
    /** After the host confirms exact native readback, atomically select current and retain superseded immutable receipts. */
    accept(expected: SnapshotPublicationRow): Effect.Effect<void, SnapshotPublicationError>;
  }
>()('@lody/e2ee-core/SnapshotPublicationJournal') {}
