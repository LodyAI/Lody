import {
  applyCodeCollabFileIndexFlockWriteBatch,
  writeCodeCollabFileIndexSignalToFlock,
  type CodeCollabFileIndexFlockWriteBatch,
  type CodeCollabFileIndexReadableFlock,
  type CodeCollabFileIndexWritableFlock,
} from '@lody/shared';
import { waitForCodeCollabTask } from './code-collab-task';

type CodeCollabFlockHandle = {
  readonly flock: CodeCollabFileIndexWritableFlock;
  readonly syncOnce: () => Promise<unknown>;
};

export type CodeCollabFlockRepo = {
  readonly openFlockDoc: (flockDocId: string) => Promise<CodeCollabFlockHandle>;
  readonly flush: () => Promise<void>;
  readonly sync?: (options: {
    readonly scope: 'doc';
    readonly flockDocIds: string[];
    readonly signal: AbortSignal;
  }) => Promise<unknown>;
};

export type CodeCollabPublicationSnapshot = {
  readonly view: CodeCollabFileIndexReadableFlock;
  readonly roomTxId?: number;
};

export type CodeCollabPublicationMutation =
  | { readonly kind: 'index'; readonly batch: CodeCollabFileIndexFlockWriteBatch }
  | { readonly kind: 'signal'; readonly revision: number };

export type CodeCollabPublicationRoom = {
  /** Remote reconciliation, when supported. Local persistence is not a cloud receipt. */
  readonly reconcile: (signal?: AbortSignal) => Promise<void>;
  readonly read: (signal?: AbortSignal) => Promise<CodeCollabPublicationSnapshot>;
  /** Commit one bounded batch and persist before confirming; never replay an unknown outcome. */
  readonly commit: (
    snapshot: CodeCollabPublicationSnapshot,
    mutation: CodeCollabPublicationMutation,
    updatedAtMs: number,
    signal?: AbortSignal
  ) => Promise<boolean>;
};

export type CodeCollabPublicationStore = {
  readonly open: (flockDocId: string, signal?: AbortSignal) => Promise<CodeCollabPublicationRoom>;
};

/** A known rejected CAS is safe to replan. Disconnect/storage errors are not conflicts. */
export class CodeCollabPublicationConflict extends Error {
  constructor(cause: unknown) {
    super('Code Collab publication snapshot changed.', { cause });
    this.name = 'CodeCollabPublicationConflict';
  }
}

/** Borrow the current Repo owner. Cancellation only ends this publication's waiter. */
export function createLegacyCodeCollabPublicationStore(
  repo: CodeCollabFlockRepo
): CodeCollabPublicationStore {
  return {
    async open(flockDocId, signal) {
      signal?.throwIfAborted();
      const handle = await waitForCodeCollabTask(repo.openFlockDoc(flockDocId), signal);
      const reconcile = async (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        // With no transport syncOnce succeeds locally. Do not turn offline work
        // into a repeated forced publication; the Repo owns later catch-up.
        await waitForCodeCollabTask(
          signal && repo.sync
            ? repo.sync({ scope: 'doc', flockDocIds: [flockDocId], signal })
            : handle.syncOnce(),
          signal
        );
        signal?.throwIfAborted();
      };
      return {
        reconcile,
        async read(signal) {
          signal?.throwIfAborted();
          // Copy rows only for planning; this is not a second CRDT/writer.
          const rows = [...handle.flock.scan()];
          return { view: { scan: () => rows } };
        },
        async commit(_snapshot, mutation, updatedAtMs, signal) {
          signal?.throwIfAborted();
          let changed: boolean;
          if (mutation.kind === 'index') {
            applyCodeCollabFileIndexFlockWriteBatch(handle.flock, mutation.batch, updatedAtMs);
            changed = true;
          } else {
            changed = writeCodeCollabFileIndexSignalToFlock(
              handle.flock,
              mutation.revision,
              updatedAtMs
            );
          }
          if (!changed) return false;
          await waitForCodeCollabTask(repo.flush(), signal);
          signal?.throwIfAborted();
          await reconcile(signal);
          return true;
        },
      };
    },
  };
}
