import { InMemoryRemoteCursorStore } from '@loro-dev/streams-crdt';
import type { LoroRepo } from 'loro-repo';
import type { StreamsReplicaPersistence } from 'loro-repo/transport/streams';

/**
 * SQLite does not yet implement atomic Flock/checkpoint recovery in loro-repo.
 * Keep progress on the loaded replica only, never import legacy durable cursors.
 * Reloads bootstrap and merge into preserved SQLite data (including local writes).
 * Documents also replay after transport reconstruction: old CLI callbacks could
 * advance their durable cursors before the scheduled persistence actually ran.
 */
export function createCliStreamsPersistence(repo: LoroRepo): StreamsReplicaPersistence {
  const cursors = new WeakMap<object, InMemoryRemoteCursorStore>();
  return {
    mode: 'replica-bound',
    cursorStoreFor: ({ flock }) => {
      let store = cursors.get(flock);
      if (!store) {
        store = new InMemoryRemoteCursorStore();
        cursors.set(flock, store);
      }
      return store;
    },
    documentRemoteCursorStore: new InMemoryRemoteCursorStore(),
    persistMeta: () => repo.persistMetaNow(),
    persistDoc: (docId, doc) => repo.persistDocNow(docId, doc),
    persistFlockDoc: (flockDocId, flock) => repo.persistFlockDocNow(flockDocId, flock),
  };
}
