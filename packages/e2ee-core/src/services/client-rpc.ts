import { Context, type Effect } from 'effect';
import type { LocalStoreError } from './errors';
/** Exact encrypted request and its public route; the caller verifies scope, signature and intent. */
export interface ClientRpcOriginal {
  readonly target: string;
  readonly signer: string;
  readonly frame: Uint8Array;
}
/** Persistent personal-client RPC originals. First ciphertext wins, batch response pages commit atomically, and returned bytes are owned. This is neither execution permission nor a receipt of network delivery. */
export class ClientRpcOriginalStore extends Context.Service<
  ClientRpcOriginalStore,
  {
    /** Read one exact request original, or absence; I/O failure never means absence. */
    read(
      direction: 'sent' | 'received',
      key: string
    ): Effect.Effect<ClientRpcOriginal | undefined, LocalStoreError>;
    /** Return the first exact sent original; changed incoming originals conflict. */
    retain(
      direction: 'sent' | 'received',
      key: string,
      record: ClientRpcOriginal
    ): Effect.Effect<ClientRpcOriginal, LocalStoreError>;
    /** Read one retained ciphertext response page. */
    readResponse(
      key: string,
      sequence: number
    ): Effect.Effect<Uint8Array | undefined, LocalStoreError>;
    /** Retain the first response at this exact sequence; changed bytes conflict. */
    retainResponse(
      key: string,
      sequence: number,
      frame: Uint8Array
    ): Effect.Effect<void, LocalStoreError>;
    /** Atomically retain all first response pages, or none; one conflicting page aborts the batch. */
    retainResponsePages(
      key: string,
      frames: readonly Uint8Array[]
    ): Effect.Effect<void, LocalStoreError>;
    /** Fence new work and drain this connection; retain originals and identity across close. */
    close(): Effect.Effect<void>;
  }
>()('@lody/e2ee-core/ClientRpcOriginalStore') {}
