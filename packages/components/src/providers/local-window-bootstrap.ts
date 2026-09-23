import type { LoroRepo } from 'loro-repo';
import type { LoroDoc } from 'loro-crdt';

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const PEER_WAIT_MS = 150;

type Channel = Pick<BroadcastChannel, 'postMessage' | 'close' | 'onmessage'>;
type Snapshot = string | Uint8Array;
type PeerRegistry = { peers(): Promise<string[]>; close(): void };

function createBrowserPeerRegistry(scope: string, id: string): PeerRegistry {
  const locks = globalThis.navigator?.locks;
  const prefix = `${scope}:peer:`;
  const controller = new AbortController();
  let release = () => {};
  const lifetime = new Promise<void>((resolve) => {
    release = resolve;
  });
  void locks
    ?.request(`${prefix}${id}`, { signal: controller.signal }, () => lifetime)
    .catch(() => {});
  return {
    async peers() {
      if (!locks) return [];
      const state = await locks.query();
      return [...(state.held ?? []), ...(state.pending ?? [])]
        .map((lock) => lock.name ?? '')
        .filter((name) => name.startsWith(prefix) && name !== `${prefix}${id}`)
        .map((name) => name.slice(prefix.length));
    },
    close() {
      controller.abort();
      release();
    },
  };
}

/** Shares rebuildable CRDT state, never replica persistence or Streams cursors. */
export function createLocalWindowBootstrap(
  repo: LoroRepo,
  workspaceId: string,
  documents: ReadonlyMap<string, LoroDoc>,
  createChannel: (name: string) => Channel = (name) => new BroadcastChannel(name),
  createRegistry: (scope: string, id: string) => PeerRegistry = createBrowserPeerRegistry
) {
  const scope = `lody:local-window-bootstrap:v1:${workspaceId}`;
  const peerId = crypto.randomUUID();
  const registry = createRegistry(scope, peerId);
  const channel = createChannel(scope);
  const pending = new Map<
    string,
    { room: string; remaining: Set<string>; finish: (value?: Snapshot) => void }
  >();
  let closed = false;
  channel.onmessage = ({ data }) => {
    if (closed || !data || typeof data.id !== 'string' || typeof data.room !== 'string') return;
    if (data.type === 'request') {
      if (data.room !== 'meta' && (!Array.isArray(data.peers) || !data.peers.includes(peerId)))
        return;
      try {
        const snapshot =
          data.room === 'meta'
            ? JSON.stringify(repo.getMeta().exportJson())
            : documents.get(data.room)?.export({ mode: 'snapshot' });
        const available =
          snapshot !== undefined &&
          snapshot.length * (typeof snapshot === 'string' ? 2 : 1) <= MAX_SNAPSHOT_BYTES;
        channel.postMessage({
          type: 'snapshot',
          id: data.id,
          room: data.room,
          peerId,
          snapshot: available ? snapshot : null,
        });
      } catch {
        // Closing peers and cache failures must not interrupt authoritative sync.
      }
    } else if (data.type === 'snapshot') {
      const entry = pending.get(data.id);
      const snapshot = data.snapshot;
      if (!entry || entry.room !== data.room) return;
      if (data.room !== 'meta') {
        if (!entry.remaining.delete(data.peerId)) return;
        if (snapshot === null) {
          if (entry.remaining.size === 0) entry.finish();
          return;
        }
      }
      if (data.room === 'meta' ? typeof snapshot !== 'string' : !(snapshot instanceof Uint8Array))
        return;
      if (snapshot.length * (typeof snapshot === 'string' ? 2 : 1) > MAX_SNAPSHOT_BYTES) return;
      if (data.room === 'meta') {
        try {
          repo.getMeta().importJson(JSON.parse(snapshot as string));
        } catch {
          // The local daemon remains authoritative if a peer snapshot is unusable.
        }
      } else {
        entry?.finish(snapshot);
      }
    }
  };
  const request = (room: string, peers: string[] = []): Promise<Snapshot | undefined> => {
    if (closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value?: Snapshot) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(value);
      };
      timer = setTimeout(() => finish(), PEER_WAIT_MS);
      pending.set(id, { room, remaining: new Set(peers), finish });
      try {
        channel.postMessage({ type: 'request', id, room, peers });
      } catch {
        finish();
      }
    });
  };
  void request('meta');
  return {
    async readDocument(room: string): Promise<Uint8Array | undefined> {
      const peers = await registry.peers().catch(() => []);
      if (closed || peers.length === 0) return undefined;
      const snapshot = await request(room, peers);
      return snapshot instanceof Uint8Array ? snapshot : undefined;
    },
    close() {
      closed = true;
      for (const entry of pending.values()) entry.finish();
      registry.close();
      channel.close();
    },
  };
}

/** Reuse the disk snapshot first; a cache hit must not export every peer's document. */
export async function readSessionBootstrapSnapshot(
  readCache: () => Promise<Uint8Array | undefined>,
  readPeer: () => Promise<Uint8Array | undefined>
): Promise<Uint8Array | undefined> {
  return (await readCache().catch(() => undefined)) ?? (await readPeer().catch(() => undefined));
}
