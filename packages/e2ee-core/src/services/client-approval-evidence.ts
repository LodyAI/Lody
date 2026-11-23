import { Context, type Effect } from 'effect';
import type { LocalStoreError } from './errors';
/** First public approval-history pages for one exact pairing session. Raw signed evidence is replayed by the host; neither stored chunks nor their checksums grant authority. This separate paged journal keeps bounded single-message pairing originals unchanged. */
export class ClientApprovalEvidenceStore extends Context.Service<
  ClientApprovalEvidenceStore,
  {
    /** Read every owned page consistently, or null only when metadata and all pages are absent. Missing/extra/corrupt pages fail, without repair. */
    load(pairingSessionId: string): Effect.Effect<readonly Uint8Array[] | null, LocalStoreError>;
    /** Atomically retain first exact pages and verify readback; changed evidence conflicts. Maximum 256 pages, 2 MiB/page and 72 MiB total. Unknown outcomes reconcile by load. */
    retain(
      pairingSessionId: string,
      pages: readonly Uint8Array[]
    ): Effect.Effect<readonly Uint8Array[], LocalStoreError>;
  }
>()('@lody/e2ee-core/ClientApprovalEvidenceStore') {}
