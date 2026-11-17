import type { Effect, Scope } from 'effect';
import type { MachineSharingError } from './errors';

/** One resource's pinned head and retained original, as stored JSON text. */
export type MachineSharingPinRow = { readonly head: string; readonly original: string | null };
/** One retained request original, as stored JSON text. */
export type MachineSharingRequestRow = { readonly requestId: string; readonly value: string };
/** What a step decided inside the store's transaction: the row to write, if any, and its result. */
export type MachineSharingStoreStep<Row, A> = { readonly write?: Row; readonly result: A };

/**
 * Durable storage for one workspace's policy pins and retained request originals:
 * ciphertext originals and high-water heads only, never keys, credentials or freshness.
 *
 * Every callback runs synchronously inside one store transaction against committed
 * state, so its decision and its write are atomic with respect to every other call on
 * the same storage, including other processes or tabs. A callback may throw to abort
 * without writing: a thrown `MachineSharingError` reaches the caller unchanged, and any
 * other failure is `sharing_storage`. An update resolves only after its write is durable.
 */
export interface MachineSharingStore {
  readonly readPin: <A>(
    resource: string,
    read: (row: MachineSharingPinRow | null) => A
  ) => Effect.Effect<A, MachineSharingError>;
  readonly updatePin: <A>(
    resource: string,
    decide: (row: MachineSharingPinRow | null) => MachineSharingStoreStep<MachineSharingPinRow, A>
  ) => Effect.Effect<A, MachineSharingError>;
  readonly readRequest: <A>(
    resource: string,
    requestId: string,
    read: (value: string | null) => A
  ) => Effect.Effect<A, MachineSharingError>;
  readonly updateRequest: <A>(
    resource: string,
    requestId: string,
    decide: (value: string | null) => MachineSharingStoreStep<string, A>
  ) => Effect.Effect<A, MachineSharingError>;
  /** Every retained request of one resource, ordered by request id. */
  readonly readRequests: <A>(
    resource: string,
    read: (rows: readonly MachineSharingRequestRow[]) => A
  ) => Effect.Effect<A, MachineSharingError>;
}

/** Opens the store within the host's Scope and closes it with that Scope. A failed
 * open is `sharing_storage` and stays retryable by the lazy host. */
export type OpenMachineSharingStore = Effect.Effect<
  MachineSharingStore,
  MachineSharingError,
  Scope.Scope
>;
