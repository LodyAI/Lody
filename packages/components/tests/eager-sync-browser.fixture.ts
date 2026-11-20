import { createEagerSyncWorkerClient } from '../src/providers/eager-sync-worker-client';
import { readEagerSyncSnapshot } from '../src/providers/eager-sync-snapshot-cache';

let now = 0;
let client: ReturnType<typeof createEagerSyncWorkerClient>;
const results = new Map<string, Promise<unknown>>();
let enteredRead: Promise<void>;
let enterRead: () => void;
const controllers = new Map<string, AbortController>();
Object.assign(globalThis, {
  configure(
    options: {
      workspaceId?: string;
      authorizationScope?: string;
      locks?: null;
      reject?: boolean;
      fail?: boolean;
      plane?: 'local' | 'cloud';
      pendingRead?: 'snapshot' | 'rejection';
    } = {}
  ) {
    client?.dispose();
    enteredRead = new Promise((resolve) => {
      enterRead = resolve;
    });
    const pendingRead = async () => {
      enterRead();
      return new Promise<undefined>(() => {});
    };
    const workspaceId = options.workspaceId ?? 'workspace';
    client = createEagerSyncWorkerClient({
      content: { mode: 'plaintext' },
      workspaceId,
      scope: workspaceId,
      authorizationScope: options.authorizationScope ?? 'account',
      locks: options.locks,
      now: () => now,
      ...(options.pendingRead === 'snapshot' ? { readSnapshot: pendingRead } : {}),
      ...(options.pendingRead === 'rejection' ? { readRejection: pendingRead } : {}),
      resolveTransport: async (roomId) =>
        options.plane === 'cloud'
          ? { plane: 'cloud', streamUrl: new URL(`/ds/bucket/${roomId}`, location.href).href }
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
      ...(options.reject || options.fail
        ? {
            createWorker: () => {
              const source = `onmessage = async ({data}) => { if(data.type !== 'start') return; await (await fetch(${JSON.stringify(new URL('/download', location.href).href)})).arrayBuffer(); postMessage({type:'complete',outcome:${JSON.stringify(options.fail ? 'failed' : 'cache_rejected')}}); };`;
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
  enteredRead: () => enteredRead,
  result: (id: string) => results.get(id),
  timeout: (id: string) => controllers.get(id)?.abort(new DOMException('deadline', 'TimeoutError')),
  retryAt: (room: string) => client.getRetryAt(room),
  cancel: (id: string) => controllers.get(id)?.abort(),
  advance: (ms: number) => {
    now += ms;
  },
  snapshot: (room: string, scope = 'workspace') =>
    readEagerSyncSnapshot(scope, room).then((row) =>
      row ? { activity: row.lastMessageAt, size: row.snapshot.size } : null
    ),
});
