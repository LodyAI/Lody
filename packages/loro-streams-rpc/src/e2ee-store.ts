import { Context, type Effect } from 'effect';
/** Exact ciphertext and public target/signer, never plaintext, credentials or authority. */
export interface StoredRpcOriginal {
  readonly target: string;
  readonly signer: string;
  readonly frame: Uint8Array;
}
/** Persistent RPC originals. Each mutation atomically retains first bytes, reads them back and completes before success. Unknown outcomes retry exact originals; no eviction/reset or plaintext fallback. */
export class E2eeRpcStore extends Context.Service<
  E2eeRpcStore,
  {
    read(
      direction: 'sent' | 'received',
      key: string
    ): Effect.Effect<StoredRpcOriginal | undefined, Error>;
    retain(
      direction: 'sent' | 'received',
      key: string,
      record: StoredRpcOriginal
    ): Effect.Effect<StoredRpcOriginal, Error>;
    readResponse(key: string, sequence: number): Effect.Effect<Uint8Array | undefined, Error>;
    retainResponse(key: string, sequence: number, frame: Uint8Array): Effect.Effect<void, Error>;
    retainResponsePages(key: string, frames: readonly Uint8Array[]): Effect.Effect<void, Error>;
    close(): Effect.Effect<void, Error>;
  }
>()('@lody/loro-streams-rpc/E2eeRpcStore') {}
