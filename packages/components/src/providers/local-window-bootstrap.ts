import type { LoroRepo } from 'loro-repo';
import type { LoroDoc } from 'loro-crdt';

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const PEER_WAIT_MS = 150;

type Channel = Pick<BroadcastChannel, 'postMessage' | 'close' | 'onmessage'>;
type Snapshot = string | Uint8Array;

/** Shares rebuildable CRDT state, never replica persistence or Streams cursors. */
export function createLocalWindowBootstrap(
  repo: LoroRepo,
  workspaceId: string,
  documents: ReadonlyMap<string, LoroDoc>,
  createChannel: (name: string) => Channel = (name) => new BroadcastChannel(name)
) {
  const channel = createChannel(`lody:local-window-bootstrap:v1:${workspaceId}`);
  const pending = new Map<string, { room: string; finish: (value?: Snapshot) => void }>();
  let closed = false;
  channel.onmessage = ({ data }) => {
    if (closed || !data || typeof data.id !== 'string' || typeof data.room !== 'string') return;
    if (data.type === 'request') {
      try {
        const snapshot =
          data.room === 'meta'
            ? JSON.stringify(repo.getMeta().exportJson())
            : documents.get(data.room)?.export({ mode: 'snapshot' });
        if (
          snapshot === undefined ||
          snapshot.length * (typeof snapshot === 'string' ? 2 : 1) > MAX_SNAPSHOT_BYTES
        )
          return;
        channel.postMessage({ type: 'snapshot', id: data.id, room: data.room, snapshot });
      } catch {
        // Closing peers and cache failures must not interrupt authoritative sync.
      }
    } else if (data.type === 'snapshot') {
      const entry = pending.get(data.id);
      const snapshot = data.snapshot;
      if (entry?.room !== data.room) return;
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
  const request = (room: string): Promise<Snapshot | undefined> => {
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
      pending.set(id, { room, finish });
      try {
        channel.postMessage({ type: 'request', id, room });
      } catch {
        finish();
      }
    });
  };
  void request('meta');
  return {
    async readDocument(room: string): Promise<Uint8Array | undefined> {
      const snapshot = await request(room);
      return snapshot instanceof Uint8Array ? snapshot : undefined;
    },
    close() {
      closed = true;
      for (const entry of pending.values()) entry.finish();
      channel.close();
    },
  };
}

/** A cache miss must not win the race against another source containing data. */
export async function firstAvailableSnapshot(
  sources: Array<Promise<Uint8Array | undefined>>
): Promise<Uint8Array | undefined> {
  return Promise.any(
    sources.map(async (source) => {
      const value = await source;
      if (!value) throw new Error('Snapshot unavailable');
      return value;
    })
  ).catch(() => undefined);
}
