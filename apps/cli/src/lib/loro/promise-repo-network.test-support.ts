import type { Flock } from '@loro-dev/flock-wasm';
import type { TransportAdapter, TransportSubscription } from 'loro-repo';

/** In-memory transport only: all ownership, hydration and replicas use Promise Repo. */
export function makePromiseRepoNetwork() {
  const rooms = new Map<string, Set<Flock>>();
  const sync = (id: string, flock: Flock) => {
    for (const remote of rooms.get(id) ?? []) {
      if (remote !== flock) flock.importFile(remote.exportFile());
    }
  };
  const join = (id: string, flock: Flock): TransportSubscription => {
    let members = rooms.get(id);
    if (!members) {
      members = new Set();
      rooms.set(id, members);
    }
    sync(id, flock);
    members.add(flock);
    const detach = flock.subscribe(() => {
      for (const peer of members) {
        if (peer !== flock) peer.importFile(flock.exportFile());
      }
    });
    return {
      status: 'joined',
      firstSyncedWithRemote: Promise.resolve(),
      waitUntilSynced: async () => {},
      onStatusChange: () => () => {},
      unsubscribe: () => {
        detach();
        members.delete(flock);
      },
    };
  };
  return {
    transport: (): TransportAdapter => ({
      connect: async () => {},
      close: async () => {},
      isConnected: () => true,
      getStatus: () => 'connected',
      onStatusChange: () => () => {},
      syncMeta: async (flock) => {
        sync('meta', flock);
        return { ok: true };
      },
      syncFlockDoc: async (id, flock) => {
        sync(id, flock);
        return { ok: true };
      },
      syncDoc: async () => ({ ok: true }),
      joinMetaRoom: (flock) => join('meta', flock),
      joinFlockDocRoom: join,
      joinDocRoom: () => ({
        status: 'joined',
        firstSyncedWithRemote: Promise.resolve(),
        waitUntilSynced: async () => {},
        onStatusChange: () => () => {},
        unsubscribe: () => {},
      }),
    }),
  };
}
