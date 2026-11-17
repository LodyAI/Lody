import { createEagerSyncWorkerClient } from '../src/providers/eager-sync-worker-client';
import { readEagerSyncSnapshot } from '../src/providers/eager-sync-snapshot-cache';

let now = 0;
let client: ReturnType<typeof createEagerSyncWorkerClient>;
const results = new Map<string, Promise<unknown>>();
const controllers = new Map<string, AbortController>();
Object.assign(globalThis, {
  configure(
    options: {
      workspaceId?: string;
      authorizationScope?: string;
      locks?: null;
      reject?: boolean;
      plane?: 'local' | 'cloud';
    } = {}
  ) {
    client?.dispose();
    const workspaceId = options.workspaceId ?? 'workspace';
    client = createEagerSyncWorkerClient({
      content: { mode: 'plaintext' },
      workspaceId,
      scope: workspaceId,
      authorizationScope: options.authorizationScope ?? 'account',
      locks: options.locks,
      now: () => now,
      resolveTransport: async (roomId) =>
        options.plane === 'cloud'
          ? {
              plane: 'cloud',
              streamId: roomId,
              options: { baseUrl: location.origin, bucketId: 'bucket', metaStreamId: 'meta' },
            }
          : { plane: 'local' },
      auth: async () => {
        throw new Error('Unexpected cloud auth');
      },
      // A synthetic local daemon boundary; the real worker/adapter still import
      // real Loro updates and commit the production IndexedDB cache.
      localConnection: () => {
        const listeners = new Set<(event: never) => void>();
        const abort = new AbortController();
        return {
          connection: {
            isConnected: () => true,
            onStatusChange: () => () => {},
            onMessage: (listener) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
            send: (message) => {
              if (message.type !== 'join') return;
              void fetch('/download', { signal: abort.signal })
                .then((response) => response.json())
                .then((body) => {
                  for (const listener of listeners)
                    listener({
                      ...body,
                      workspaceId,
                      peerId: message.peerId,
                      requestId: message.requestId,
                      room: message.room,
                    } as never);
                })
                .catch(() => {});
            },
          },
          dispose: () => abort.abort(),
        };
      },
      // Exercise rejection with a real Worker that finishes only after receiving
      // real downloaded bytes, without allocating a >128MiB synthetic history.
      ...(options.reject
        ? {
            createWorker: () => {
              const source = `onmessage = async ({data}) => { if(data.type !== 'start') return; await (await fetch(${JSON.stringify(new URL('/download', location.href).href)})).arrayBuffer(); postMessage({type:'complete',outcome:'cache_rejected'}); }; postMessage({type:'ready'});`;
              const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
              const worker = new Worker(url);
              URL.revokeObjectURL(url);
              return worker;
            },
          }
        : {}),
    });
  },
  start(id: string, room: string, activity: number) {
    const controller = new AbortController();
    controllers.set(id, controller);
    results.set(id, client.prefetch(room, activity, controller.signal));
  },
  result: (id: string) => results.get(id),
  cancel: (id: string) => controllers.get(id)?.abort(),
  advance: (ms: number) => {
    now += ms;
  },
  snapshot: (room: string, scope = 'workspace') =>
    readEagerSyncSnapshot(scope, room).then((row) =>
      row ? { activity: row.lastMessageAt, size: row.snapshot.size } : null
    ),
});
