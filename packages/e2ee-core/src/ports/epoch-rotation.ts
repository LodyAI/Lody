import { Context, Effect } from 'effect';
import type { EpochKey, EpochNumber, GenesisHash } from '../pure/bytes';
import type { StorageError } from '../pure/errors';

export interface EpochCandidateTransaction {
  readonly load: Effect.Effect<string | null, StorageError>;
  /** Saves exact candidate JSON durably before returning; never removes on interruption. */
  readonly save: (text: string) => Effect.Effect<void, StorageError>;
  readonly clear: Effect.Effect<void, StorageError>;
}

/** Per-Org exclusive lease, including across processes for durable implementations. */
export class EpochCandidateStore extends Context.Tag('@lody/e2ee-core/EpochCandidateStore')<
  EpochCandidateStore,
  {
    readonly exclusive: <A, E, R>(
      genesis: GenesisHash,
      work: (tx: EpochCandidateTransaction) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | StorageError, R>;
  }
>() {}

/** Append-only key installation. Current epoch comes from verified ledger, not this store. */
export class EpochKeyring extends Context.Tag('@lody/e2ee-core/EpochKeyring')<
  EpochKeyring,
  {
    readonly get: (
      genesis: GenesisHash,
      epoch: EpochNumber
    ) => Effect.Effect<EpochKey | null, StorageError>;
    /** Exact repeated keys are idempotent; differing bytes for an existing slot fail closed. */
    readonly put: (
      genesis: GenesisHash,
      epoch: EpochNumber,
      key: EpochKey
    ) => Effect.Effect<void, StorageError>;
  }
>() {}
