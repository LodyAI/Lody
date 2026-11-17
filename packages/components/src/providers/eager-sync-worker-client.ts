import {
  requirePlaintextWorkspaceStreamsContent,
  type WorkspaceStreamsMode,
} from '@lody/shared/workspace-streams-content';
import { LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION } from '@lody/shared/local-loro-data-plane';
import type { LocalLoroDataPlaneConnection } from '@lody/shared/local-loro-transport';
import type { PrefetchOutcome } from './background-sync-coordinator';
import { readEagerSyncSnapshot } from './eager-sync-snapshot-cache';
import {
  CACHE_REJECTION_COOLDOWN_MS,
  readEagerSyncRejection,
  writeEagerSyncRejection,
} from './eager-sync-admission';
import type {
  EagerSyncAuthContext,
  EagerSyncTransport,
  EagerSyncWorkerInput,
  EagerSyncWorkerOutput,
} from './eager-sync-worker-protocol';

// Shared across runtime instances in this renderer, including workspace switches.
// A cancelled job terminates its worker BEFORE releasing this slot.
let workerQueue: Promise<unknown> = Promise.resolve();

export type EagerSyncWorkerClientDeps = {
  content: WorkspaceStreamsMode;
  workspaceId: string;
  scope: string;
  authorizationScope: string;
  locks?: Pick<LockManager, 'request'> | null;
  now?: () => number;
  readRejection?: typeof readEagerSyncRejection;
  writeRejection?: typeof writeEagerSyncRejection;
  resolveTransport(roomId: string): Promise<EagerSyncTransport>;
  auth(context?: EagerSyncAuthContext): Promise<string | undefined>;
  localConnection(): { connection: LocalLoroDataPlaneConnection; dispose(): void } | null;
  readSnapshot?: typeof readEagerSyncSnapshot;
  createWorker?: () => Worker;
};

export function createEagerSyncWorkerClient(deps: EagerSyncWorkerClientDeps) {
  const jobs = new Map<string, AbortController>();
  let disposed = false;
  // Bounded fallback if browser storage refuses even the small rejection row.
  const rejections = new Map<
    string,
    { lastMessageAt: number; rejectedAt: number; outcome?: 'failed' }
  >();

  // These ports only read. Cancellation can abandon their result safely; a
  // late read must never construct a Worker or retain the renderer's slot.
  const readUntilCancelled = async <T>(
    read: Promise<T>,
    signal: AbortSignal
  ): Promise<T | undefined> => {
    const observed = read.catch(() => undefined);
    if (signal.aborted) return undefined;
    let abort: () => void = () => {};
    const cancelled = new Promise<undefined>((resolve) => {
      abort = () => resolve(undefined);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([observed, cancelled]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };

  const run = async (
    roomId: string,
    lastMessageAt: number,
    signal: AbortSignal
  ): Promise<PrefetchOutcome> => {
    requirePlaintextWorkspaceStreamsContent(deps.content);
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
    const key = JSON.stringify([
      deps.workspaceId,
      roomId,
      deps.scope,
      deps.authorizationScope,
      transport.plane,
      ...(transport.plane === 'cloud' ? [transport.streamUrl] : []),
    ]);
    // Optional background work must not fall back to overlapping downloads when
    // the browser cannot coordinate windows. Foreground opens remain independent.
    const locks = deps.locks === undefined ? globalThis.navigator?.locks : deps.locks;
    if (!locks) return 'skipped';
    return locks.request(`lody:eager-sync:${key}`, { ifAvailable: true }, async (lock) => {
      if (!lock || signal.aborted || disposed) return 'skipped';
      // Re-read AFTER the claim: a previous owner may have committed while this
      // renderer was resolving its transport. No Worker/WASM on a cache hit.
      const cached = await readUntilCancelled(
        (deps.readSnapshot ?? readEagerSyncSnapshot)(deps.scope, roomId),
        signal
      );
      if (signal.aborted || disposed) return 'skipped';
      if (cached?.plane === transport.plane && cached.lastMessageAt >= lastMessageAt) {
        return 'synced';
      }
      const rejected =
        (await readUntilCancelled(
          (deps.readRejection ?? readEagerSyncRejection)(key, signal),
          signal
        )) ?? rejections.get(key);
      if (signal.aborted || disposed) return 'skipped';
      const now = (deps.now ?? Date.now)();
      if (
        rejected &&
        rejected.lastMessageAt >= lastMessageAt &&
        now - rejected.rejectedAt < CACHE_REJECTION_COOLDOWN_MS
      )
        return rejected.outcome === 'failed' ? 'failed' : 'cache_rejected';
      if (signal.aborted || disposed) return 'skipped';
      const outcome = await runWorker(roomId, lastMessageAt, signal, transport);
      // runWorker resolves only after terminating the Worker and detaching its
      // local peer. Keep the claim through the durable rejection receipt too.
      if (outcome === 'cache_rejected' || outcome === 'failed') {
        const row = {
          key,
          lastMessageAt,
          rejectedAt: (deps.now ?? Date.now)(),
          ...(outcome === 'failed' ? { outcome: 'failed' as const } : {}),
        };
        rejections.delete(key);
        rejections.set(key, row);
        if (rejections.size > 1000) rejections.delete(rejections.keys().next().value!);
        // A timed-out worker is already terminated. Give its failure receipt an
        // independent bounded write so an aborted task cannot erase cooldown
        // across renderer restarts; retain the claim until the transaction ends.
        const receiptSignal = outcome === 'failed' ? AbortSignal.timeout(2_000) : signal;
        await (deps.writeRejection ?? writeEagerSyncRejection)(row, receiptSignal).catch(() => {});
      }
      return outcome;
    });
  };

  const runWorker = async (
    roomId: string,
    lastMessageAt: number,
    signal: AbortSignal,
    transport: EagerSyncTransport
  ): Promise<PrefetchOutcome> => {
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
        let cleanupFailed = false;
        for (const stop of unsubscribe) {
          try {
            stop();
          } catch {
            cleanupFailed = true;
          }
        }
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
        try {
          local?.dispose();
        } catch {
          cleanupFailed = true;
        }
        resolve(cleanupFailed ? 'failed' : outcome);
      };
      const abort = () => finish(signal.reason?.name === 'TimeoutError' ? 'failed' : 'skipped');
      signal.addEventListener('abort', abort, { once: true });
      worker.onerror = () => finish('failed');
      worker.onmessageerror = () => finish('failed');
      worker.onmessage = ({ data }: MessageEvent<EagerSyncWorkerOutput>) => {
        if (settled) return;
        if (data.type === 'ready') startWorker();
        else if (data.type === 'complete') finish(data.outcome);
        else if (data.type === 'local-send') {
          try {
            local?.connection.send(data.message);
          } catch {
            finish('failed');
          }
        } else if (data.type === 'auth' && transport.plane === 'cloud') {
          void deps.auth(data.context).then(
            (token) => post({ type: 'auth-result', id: data.id, token }),
            () => finish('failed')
          );
        }
      };
      let workerStarted = false;
      const startWorker = () => {
        if (workerStarted || settled) return;
        workerStarted = true;
        try {
          if (signal.aborted || disposed) {
            finish('skipped');
            return;
          }
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
            content: deps.content,
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
      };
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
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      jobs.set(roomId, controller);
      let cancelWait: () => void = () => {};
      const cancelled = new Promise<PrefetchOutcome>((resolve) => {
        cancelWait = () =>
          resolve(controller.signal.reason?.name === 'TimeoutError' ? 'failed' : 'skipped');
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
