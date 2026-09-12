import { LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION } from '@lody/shared/local-loro-data-plane';
import type { LocalLoroDataPlaneConnection } from '@lody/shared/local-loro-transport';
import type { PrefetchOutcome } from './background-sync-coordinator';
import type {
  EagerSyncTransport,
  EagerSyncWorkerInput,
  EagerSyncWorkerOutput,
} from './eager-sync-worker-protocol';

// Shared across runtime instances in this renderer, including workspace switches.
// A cancelled job terminates its worker BEFORE releasing this slot.
let workerQueue: Promise<unknown> = Promise.resolve();

export type EagerSyncWorkerClientDeps = {
  workspaceId: string;
  scope: string;
  resolveTransport(roomId: string): Promise<EagerSyncTransport>;
  auth(reason?: string): Promise<string | undefined>;
  localConnection(): { connection: LocalLoroDataPlaneConnection; dispose(): void } | null;
  createWorker?: () => Worker;
};

export function createEagerSyncWorkerClient(deps: EagerSyncWorkerClientDeps) {
  const jobs = new Map<string, AbortController>();
  let disposed = false;

  const run = async (
    roomId: string,
    lastMessageAt: number,
    signal: AbortSignal
  ): Promise<PrefetchOutcome> => {
    if (signal.aborted || disposed) return 'skipped';
    let abortSetup: () => void = () => {};
    const cancelled = new Promise<null>((resolve) => {
      abortSetup = () => resolve(null);
      signal.addEventListener('abort', abortSetup, { once: true });
    });
    let transport: EagerSyncTransport | null;
    try {
      transport = await Promise.race([deps.resolveTransport(roomId), cancelled]);
    } finally {
      signal.removeEventListener('abort', abortSetup);
    }
    if (!transport) return 'skipped';
    if (signal.aborted || disposed) return 'skipped';
    const peerId = `eager-sync:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random().toString(36)}`}`;
    const worker = (
      deps.createWorker ??
      (() => new Worker(new URL('./eager-sync.worker.ts', import.meta.url), { type: 'module' }))
    )();
    return new Promise<PrefetchOutcome>((resolve) => {
      let settled = false;
      let local: ReturnType<EagerSyncWorkerClientDeps['localConnection']> = null;
      const unsubscribe: Array<() => void> = [];
      const post = (message: EagerSyncWorkerInput) => {
        if (!settled) worker.postMessage(message);
      };
      const finish = (outcome: PrefetchOutcome) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        worker.terminate();
        for (const stop of unsubscribe) stop();
        // Termination can interrupt a synchronous WASM import, so the parent
        // owns detach; it must not depend on the worker processing cancellation.
        try {
          local?.connection.send({
            type: 'detach',
            protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
            workspaceId: deps.workspaceId,
            peerId,
          });
        } catch {
          /* A disconnected relay already lost this peer. */
        }
        local?.dispose();
        resolve(outcome);
      };
      const abort = () => finish('skipped');
      signal.addEventListener('abort', abort, { once: true });
      worker.onerror = () => finish('failed');
      worker.onmessageerror = () => finish('failed');
      worker.onmessage = ({ data }: MessageEvent<EagerSyncWorkerOutput>) => {
        if (settled) return;
        if (data.type === 'complete') finish(data.outcome);
        else if (data.type === 'local-send') {
          try {
            local?.connection.send(data.message);
          } catch {
            finish('failed');
          }
        } else if (data.type === 'auth' && transport.plane === 'cloud') {
          void deps.auth(data.reason).then(
            (token) => post({ type: 'auth-result', id: data.id, token }),
            () => finish('failed')
          );
        }
      };
      try {
        if (transport.plane === 'local') {
          local = deps.localConnection();
          if (!local) {
            finish('failed');
            return;
          }
          unsubscribe.push(
            local.connection.onMessage((event) => {
              // Never clone another session's large frames into this worker.
              if (
                'workspaceId' in event &&
                event.workspaceId === deps.workspaceId &&
                'peerId' in event &&
                event.peerId === peerId
              ) {
                post({ type: 'local-event', event });
              }
            })
          );
          unsubscribe.push(
            local.connection.onStatusChange((connected) => {
              post({ type: 'local-status', connected });
            })
          );
        }
        post({
          type: 'start',
          scope: deps.scope,
          workspaceId: deps.workspaceId,
          roomId,
          peerId,
          lastMessageAt,
          transport,
          connected: local?.connection.isConnected() ?? false,
        });
      } catch {
        finish('failed');
      }
    });
  };

  return {
    async prefetch(
      roomId: string,
      lastMessageAt: number,
      signal: AbortSignal
    ): Promise<PrefetchOutcome> {
      if (disposed || signal.aborted || jobs.has(roomId)) return 'skipped';
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      jobs.set(roomId, controller);
      let cancelWait: () => void = () => {};
      const cancelled = new Promise<PrefetchOutcome>((resolve) => {
        cancelWait = () => resolve('skipped');
        controller.signal.addEventListener('abort', cancelWait, { once: true });
      });
      const task = workerQueue
        .then(() => run(roomId, lastMessageAt, controller.signal))
        .catch((): PrefetchOutcome => 'failed');
      workerQueue = task;
      try {
        return await Promise.race([task, cancelled]);
      } finally {
        signal.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', cancelWait);
        if (jobs.get(roomId) === controller) jobs.delete(roomId);
      }
    },
    cancel(roomId: string) {
      jobs.get(roomId)?.abort();
    },
    cancelAll() {
      for (const controller of jobs.values()) controller.abort();
    },
    dispose() {
      disposed = true;
      for (const controller of jobs.values()) controller.abort();
      jobs.clear();
    },
  };
}
