import type { LoroRepo } from 'loro-repo';
import {
  createRepoStreamsPersistence,
  type RepoStreamsPersistenceOptions,
  type StreamsReplicaPersistence,
} from 'loro-repo/transport/streams';

/** Keep the recovery bypass on the actual replica checkpoint, not the legacy DB. */
export function createRendererStreamsPersistence(
  repo: LoroRepo,
  options: RepoStreamsPersistenceOptions & { shouldBypassMetaLoad: () => boolean }
): StreamsReplicaPersistence {
  const persistence = createRepoStreamsPersistence(repo, options);
  return {
    ...persistence,
    cursorStoreFor: (target) => {
      const store = persistence.cursorStoreFor(target);
      if (target.kind !== 'meta') return store;
      return {
        load: (url) => (options.shouldBypassMetaLoad() ? Promise.resolve(null) : store.load(url)),
        save: (cursor) => store.save(cursor),
        delete: async (url) => {
          if (!store.delete) throw new Error('Replica checkpoint deletion is unsupported');
          await store.delete(url);
        },
      };
    },
  };
}

export async function invalidateRendererMetaCheckpoint(
  repo: LoroRepo,
  streamUrl: string
): Promise<void> {
  const store = repo.getReplicaCheckpointStore({ kind: 'meta', flock: repo.getMeta() });
  if (!store.delete) throw new Error('Replica checkpoint deletion is unsupported');
  await store.delete(streamUrl);
}
