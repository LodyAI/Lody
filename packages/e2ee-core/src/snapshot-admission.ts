import { Effect, Layer } from 'effect';
import { ContentCipher, type ContentAuthor, type ContentHeader } from './content';
import { runPromiseThrow } from './effect-run';
import { CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS as WINDOW } from './pure/snapshot-admission';
import { admitSnapshot } from './workflows/snapshot-admission';
import {
  admissionClockLayer,
  snapshotAuthenticatorLayer,
  snapshotStoreLayer,
  snapshotWriteGateLayer,
} from './platform/snapshot-admission';
import {
  MemorySnapshotPublicationStore,
  type SnapshotPublicationStore,
  type PublishedSnapshot,
} from './snapshot-publication-store';
export {
  MemorySnapshotPublicationStore,
  type SnapshotPublicationStore,
  type SnapshotPublicationTransaction,
  type PublishedSnapshot,
} from './snapshot-publication-store';

/** Worst residual authorization window already accepted for this package. Not a production JWT. */
export const CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS = WINDOW;

export const SNAPSHOT_ADMISSION_DEVICE_HEADER = 'x-lody-snapshot-device';
export const SNAPSHOT_ADMISSION_LEASE_ISSUED_HEADER = 'x-lody-lease-issued-at';
export const SNAPSHOT_ADMISSION_LEASE_EXPIRES_HEADER = 'x-lody-lease-expires-at';

export interface ContentSnapshotPut {
  readonly streamKey: string;
  readonly offset: string;
  readonly body: Uint8Array;
  /** Authenticated submitting device, not a header claim inside the envelope. */
  readonly submittingDevice: string;
  readonly leaseIssuedAt: number;
  readonly leaseExpiresAt: number;
  readonly expectedGenesis: string;
  readonly expectedResource: string;
}

export interface ContentSnapshotAdmissionResult {
  readonly status: 'accepted' | 'idempotent';
  readonly currentOffset: string;
  readonly currentBody: Uint8Array;
  readonly header: Readonly<ContentHeader> | null;
}

export interface ContentSnapshotAdmissionOptions {
  /** Omit only for the non-durable memory prototype. */
  readonly store?: SnapshotPublicationStore;
  readonly cipher: ContentCipher;
  /** Current document-write capability at admit time. Not historical acceptance. */
  readonly mayWriteDocument: (author: ContentAuthor) => boolean;
  /** Injected Unix milliseconds. Queue delay must not extend leaseExpiresAt. */
  readonly now: () => number;
}

/**
 * Trusted host admission. Storage is the source of publication identity, never
 * a per-process cache. Signature verification does not hold a database lock.
 * Promise SDK/host boundary; the algorithm lives in workflows/snapshot-admission.ts.
 */
export function createContentSnapshotPublication(options: ContentSnapshotAdmissionOptions) {
  const store = options.store ?? new MemorySnapshotPublicationStore();
  const layer = Layer.mergeAll(
    snapshotStoreLayer(store),
    snapshotAuthenticatorLayer(options.cipher),
    snapshotWriteGateLayer(options.mayWriteDocument),
    admissionClockLayer(options.now)
  );
  return {
    async admit(input: ContentSnapshotPut): Promise<ContentSnapshotAdmissionResult> {
      const result = await runPromiseThrow(admitSnapshot(input).pipe(Effect.provide(layer)));
      return result as ContentSnapshotAdmissionResult;
    },
    current(streamKey: string): PublishedSnapshot | undefined {
      return store.transaction(streamKey, (tx) => tx.current());
    },
  };
}

export type ContentSnapshotPublication = ReturnType<typeof createContentSnapshotPublication>;
