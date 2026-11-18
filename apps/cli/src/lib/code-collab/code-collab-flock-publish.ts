import { randomUUID } from 'node:crypto';
import {
  readCodeCollabFileGenerations,
  CODE_COLLAB_FILE_GENERATION_MAX_BYTES,
  readCodeCollabFileIndexFromFlock,
  readCodeCollabFileIndexSignalFromFlock,
  codeCollabFileIndexValuesEqual,
  planCodeCollabFileIndexFlockWrite,
  type CodeCollabFileGenerations,
  type CodeCollabV2FileIndexState,
} from '@lody/shared';
import {
  CodeCollabPublicationConflict,
  type CodeCollabPublicationStore,
} from './code-collab-publication-store';

const diffGenerationEpoch = randomUUID();
let diffGenerationCounter = 0;
const MAX_PUBLICATION_CONFLICTS = 8;

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
  readonly store: CodeCollabPublicationStore;
  readonly flockDocId: string;
  readonly fileIndex: CodeCollabV2FileIndexState;
  readonly updatedAtMs: number;
  readonly reconcileRemote: boolean;
  readonly resetDiffGenerations?: boolean;
  readonly bumpDiffPaths?: readonly string[];
}): Promise<{ readonly changed: boolean; readonly generations: CodeCollabFileGenerations }> {
  args.signal?.throwIfAborted();
  const room = await args.store.open(args.flockDocId, args.signal);
  if (args.reconcileRemote) await room.reconcile(args.signal);
  args.signal?.throwIfAborted();
  let snapshot = await room.read(args.signal);
  const previous = readCodeCollabFileIndexFromFlock(snapshot.view);
  const previousGenerations = readCodeCollabFileGenerations(snapshot.view);
  const generations: Record<string, string> = {};
  const bumped = new Set(args.bumpDiffPaths);
  for (const [path, value] of Object.entries(args.fileIndex)) {
    const changed = value !== true && 'change' in value && value.change !== undefined;
    if (!changed) continue;
    generations[path] =
      !args.resetDiffGenerations &&
      !bumped.has(path) &&
      previousGenerations[path] &&
      Buffer.byteLength(JSON.stringify(previousGenerations[path])) <=
        CODE_COLLAB_FILE_GENERATION_MAX_BYTES + 2 &&
      codeCollabFileIndexValuesEqual(previous[path], value)
        ? previousGenerations[path]
        : `${diffGenerationEpoch}.${++diffGenerationCounter}`;
  }
  let changed = false;
  let conflicts = 0;
  // Re-read after each persisted batch. Native CAS may reject a known stale
  // snapshot; only that rejection can retry. Disconnects have unknown outcomes
  // and are returned to the existing owner-scoped repair workflow.
  for (;;) {
    args.signal?.throwIfAborted();
    const batch = planCodeCollabFileIndexFlockWrite(snapshot.view, args.fileIndex, {
      generations,
    })[0];
    if (!batch) return { changed, generations };
    try {
      await room.commit(snapshot, { kind: 'index', batch }, args.updatedAtMs, args.signal);
      changed = true;
    } catch (error) {
      if (
        error instanceof CodeCollabPublicationConflict &&
        conflicts++ < MAX_PUBLICATION_CONFLICTS
      ) {
        snapshot = await room.read(args.signal);
        continue;
      }
      throw new CodeCollabFileIndexChangedPublishError(error);
    }
    try {
      snapshot = await room.read(args.signal);
    } catch (error) {
      throw new CodeCollabFileIndexChangedPublishError(error);
    }
  }
}

export async function publishCodeCollabFileIndexSignalFlock(args: {
  readonly signal?: AbortSignal;
  readonly store: CodeCollabPublicationStore;
  readonly flockDocId: string;
  readonly updatedAtMs: number;
}): Promise<{ readonly changed: boolean; readonly revision: number }> {
  args.signal?.throwIfAborted();
  const room = await args.store.open(args.flockDocId, args.signal);
  await room.reconcile(args.signal);
  for (let conflicts = 0; ; conflicts++) {
    args.signal?.throwIfAborted();
    const snapshot = await room.read(args.signal);
    const previous = readCodeCollabFileIndexSignalFromFlock(snapshot.view);
    const revision = (previous?.r ?? 0) + 1;
    try {
      const changed = await room.commit(
        snapshot,
        { kind: 'signal', revision },
        args.updatedAtMs,
        args.signal
      );
      return { changed, revision };
    } catch (error) {
      if (error instanceof CodeCollabPublicationConflict && conflicts < MAX_PUBLICATION_CONFLICTS)
        continue;
      throw error;
    }
  }
}
