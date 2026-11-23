import { Context, type Effect } from 'effect';
import type { ClientCustodyBinding } from './client-custody';
import type { LocalStoreError } from './errors';

/** Local pairing journal purpose; distinct from KEK wrapping purposes and never an approval verdict. */
export type ClientPairingPurpose = 'request' | 'approval' | 'claim';
/** Local custody owner and exact pairing session. The original's author is verified separately by the host. */
export interface ClientPairingKey extends ClientCustodyBinding {
  /** Lowercase hex of the original 16-byte pairing session id; never allocate another on retry. */
  readonly pairingSessionId: string;
  /** Which original exchange this slot retains; no phase grants authority. */
  readonly purpose: ClientPairingPurpose;
}
/** Copy-owning first original and its optional first response, with a monotonically increasing local revision. */
export interface ClientPairingOriginal {
  /** Starts at 1; a receipt transition increments exactly once. Revisions never establish trust. */
  readonly revision: number;
  /** Exact public signed bytes, or an already protected bundle when credentials are present. Never raw private keys or credentials. */
  readonly original: Uint8Array;
  /** Exact untrusted response bytes, or null while unknown. Private response material must already be protected. */
  readonly receipt: Uint8Array | null;
}
/**
 * Retained pairing/request, approval and claim originals. The host protects
 * secret material before storage, verifies signatures/approval on every resume,
 * and persists originals before network. This store neither signs nor decides
 * whether a response authorizes anything. Each blob is bounded to 16 MiB.
 *
 * The first original wins. Initial CAS uses null, revision 1 and null receipt;
 * only its first receipt may be added at revision 2. Exact retries are no-ops;
 * changed originals/receipts conflict. No deletion/reset is implied by logout,
 * cache cleanup, receipt presence or installation replacement.
 * @category Local storage ports
 */
export class ClientPairingOriginalStore extends Context.Service<
  ClientPairingOriginalStore,
  {
    /** Read owned original/receipt bytes for the exact local binding and session; failure is never absence. */
    load(key: ClientPairingKey): Effect.Effect<ClientPairingOriginal | null, LocalStoreError>;
    /** Atomically compare revision, retain first bytes and read back the write. Unknown outcomes reconcile by load/list, never re-sign. */
    compareAndSet(
      key: ClientPairingKey,
      expectedRevision: number | null,
      next: ClientPairingOriginal
    ): Effect.Effect<void, LocalStoreError>;
    /** Enumerate retained exchanges of one exact local incarnation, in opaque cursor order. This includes receipts, not just unresolved work. */
    list(
      binding: ClientCustodyBinding,
      cursor: string | null,
      limit: number
    ): Effect.Effect<
      {
        readonly entries: readonly {
          readonly key: ClientPairingKey;
          readonly value: ClientPairingOriginal;
        }[];
        readonly next: string | null;
      },
      LocalStoreError
    >;
  }
>()('@lody/e2ee-core/ClientPairingOriginalStore') {}
