import { waitForCodeCollabTask } from './code-collab-task';
import {
  readCodeCollabFileIndexSignalFromFlock,
  writeCodeCollabFileIndexSignalToFlock,
  applyCodeCollabFileIndexFlockWriteBatch,
  planCodeCollabFileIndexFlockWrite,
  type CodeCollabFileIndexWritableFlock,
  type CodeCollabV2FileIndexState,
} from '@lody/shared';

// Publication confirmation relies on `syncOnce()` THROWING on failure: the CLI
// repo routes exactly one 'streams' transport, and loro-repo rethrows a
// single-transport failure unchanged. With ZERO transports (offline, nothing
// attached) `syncOnce()` resolves vacuously and publication is treated as
// succeeded — deliberate parity with the pre-multi-transport placeholder.
// Treating that as failure would put every offline publish into the bounded
// repair loop, which force-republishes and bumps the signal revision every
// ~30s for as long as the daemon stays deliberately offline; cloud catch-up
// after re-attach is owned by loro-repo's room rebind/resync instead.
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

export class CodeCollabFileIndexChangedPublishError extends Error {
  constructor(cause: unknown) {
    super('Code Collab file-index publication failed after changing local Flock state.', {
      cause,
    });
    this.name = 'CodeCollabFileIndexChangedPublishError';
  }
}

export async function publishCodeCollabFileIndexFlock(args: {
  readonly signal?: AbortSignal;
  readonly repo: CodeCollabFlockRepo;
  readonly flockDocId: string;
  readonly fileIndex: CodeCollabV2FileIndexState;
  readonly updatedAtMs: number;
  readonly reconcileRemote: boolean;
}): Promise<{ readonly changed: boolean }> {
  args.signal?.throwIfAborted();
  const handle = await waitForCodeCollabTask(args.repo.openFlockDoc(args.flockDocId), args.signal);
  if (args.reconcileRemote) {
    await syncFlock(args.repo, handle, args.flockDocId, args.signal);
  }
  args.signal?.throwIfAborted();
  // Each batch is one Flock commit within CODE_COLLAB_FILE_INDEX_LIMITS.maxBytes.
  // Flush + sync between batches is the barrier that makes each commit its own
  // Streams export, so cleaning up an oversized legacy index never becomes one
  // multi-megabyte append. A failure mid-way leaves the new rows already written
  // and the repair loop re-plans from the replica, finishing the cleanup.
  const batches = planCodeCollabFileIndexFlockWrite(handle.flock, args.fileIndex);
  if (batches.length === 0) {
    return { changed: false };
  }
  try {
    for (const batch of batches) {
      args.signal?.throwIfAborted();
      applyCodeCollabFileIndexFlockWriteBatch(handle.flock, batch, args.updatedAtMs);
      await waitForCodeCollabTask(args.repo.flush(), args.signal);
      args.signal?.throwIfAborted();
      await syncFlock(args.repo, handle, args.flockDocId, args.signal);
    }
  } catch (error) {
    throw new CodeCollabFileIndexChangedPublishError(error);
  }
  return { changed: true };
}

export async function publishCodeCollabFileIndexSignalFlock(args: {
  readonly signal?: AbortSignal;
  readonly repo: CodeCollabFlockRepo;
  readonly flockDocId: string;
  readonly updatedAtMs: number;
}): Promise<{ readonly changed: boolean; readonly revision: number }> {
  args.signal?.throwIfAborted();
  const handle = await waitForCodeCollabTask(args.repo.openFlockDoc(args.flockDocId), args.signal);
  await syncFlock(args.repo, handle, args.flockDocId, args.signal);
  args.signal?.throwIfAborted();
  const previous = readCodeCollabFileIndexSignalFromFlock(handle.flock);
  const revision = (previous?.r ?? 0) + 1;
  const changed = writeCodeCollabFileIndexSignalToFlock(handle.flock, revision, args.updatedAtMs);
  if (changed) {
    await waitForCodeCollabTask(args.repo.flush(), args.signal);
    args.signal?.throwIfAborted();
    await syncFlock(args.repo, handle, args.flockDocId, args.signal);
  }
  return { changed, revision };
}

async function syncFlock(
  repo: CodeCollabFlockRepo,
  handle: CodeCollabFlockHandle,
  flockDocId: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  // The shared Repo/Streams owner serializes its raw I/O even after a caller aborts.
  // Never destroy/reopen that owner merely to cancel one optional refresh.
  await waitForCodeCollabTask(
    signal && repo.sync
      ? repo.sync({ scope: 'doc', flockDocIds: [flockDocId], signal })
      : handle.syncOnce(),
    signal
  );
  signal?.throwIfAborted();
}
