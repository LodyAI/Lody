import { getSessionRoomId, type SessionId } from '@lody/shared';
import type {
  SessionData,
  SessionDataChangeListener,
  SessionHistoryReader,
  SessionSnapshot,
  SessionTurnRead,
} from '@lody/shared/session-data';
import type {
  SessionOwnerEvent,
  SessionOwnerRequest,
  SessionOwnerSnapshot,
} from '@lody/shared/session-owner-protocol';
import type { SessionDocState, SessionDocStore } from '../atoms/runtime';
import type { RoomSyncState } from '../lib/room-sync-state';
import { createConversationViewFromReader } from '../lib/conversation-view/create-conversation-view-from-reader';
import {
  INITIAL_CONVERSATION_WINDOW_TURNS,
  precedingUserRangeStart,
} from '../lib/conversation-view/types';

export type SessionOwnerTransport = {
  request(request: SessionOwnerRequest): Promise<unknown>;
  subscribe(listener: (event: SessionOwnerEvent) => void): () => void;
};

const handles = new WeakMap<SessionOwnerTransport, WeakMap<SessionSnapshot, string>>();
const finalizers = new WeakMap<SessionOwnerTransport, FinalizationRegistry<SessionOwnerRequest>>();

/** A viewing window holds projections and leases, never a session CRDT replica. */
export async function createSharedSessionClientStore(
  transport: SessionOwnerTransport,
  workspaceId: string,
  sessionId: SessionId,
  legacySnapshot?: Uint8Array
): Promise<SessionDocStore> {
  let leaseId = crypto.randomUUID();
  let disposed = false;
  let snapshot: SessionOwnerSnapshot | undefined;
  let sequence = -1;
  let reopening: Promise<void> | null = null;
  let failure: Error | null = null;
  let opening = true;
  let syncRefs = 0;
  const initialBodies = new Map<string, SessionTurnRead>();
  const earlyChanges: Parameters<SessionDataChangeListener>[0][] = [];
  const buffered: SessionOwnerEvent[] = [];
  const historyListeners = new Set<SessionDataChangeListener>();
  const stateListeners = new Set<(state: SessionDocState) => void>();
  const syncListeners = new Set<(state: RoomSyncState) => void>();
  let snapshotTokens = handles.get(transport);
  if (!snapshotTokens) {
    snapshotTokens = new WeakMap();
    handles.set(transport, snapshotTokens);
  }
  let finalizer = finalizers.get(transport);
  if (!finalizer) {
    finalizer = new FinalizationRegistry((request) => {
      void transport.request(request).catch(() => {});
    });
    finalizers.set(transport, finalizer);
  }
  const retain = (handle: object, token: string) =>
    finalizer!.register(handle, {
      workspaceId,
      sessionId,
      leaseId,
      method: 'releaseHandle',
      args: [token],
    });
  let resolveFirstSynced: () => void = () => {};
  const firstSynced = new Promise<void>((resolve) => {
    resolveFirstSynced = resolve;
  });
  const call = async (method: SessionOwnerRequest['method'], args: unknown[] = []) => {
    if (disposed) throw new Error('Session view closed');
    if (failure) throw failure;
    const lease = leaseId;
    const value = await transport.request({ workspaceId, sessionId, leaseId: lease, method, args });
    if (lease !== leaseId || disposed)
      throw new Error('Session owner changed; operation outcome may be unknown');
    return value;
  };
  const apply = (event: SessionOwnerEvent) => {
    if (!snapshot || event.generation !== snapshot.generation || event.sequence <= sequence) return;
    sequence = event.sequence;
    if (event.kind === 'history') {
      if (event.change.kind === 'structure') initialBodies.clear();
      else for (const id of event.change.ids) initialBodies.delete(id);
      if (!historyListeners.size) earlyChanges.push(event.change);
      for (const listener of historyListeners) listener(event.change);
    }
    if (event.kind === 'state') {
      snapshot.state = event.state;
      for (const listener of stateListeners) listener(event.state as SessionDocState);
    }
    if (event.kind === 'sync') {
      snapshot.syncState = event.state;
      if (event.state === 'synced') resolveFirstSynced();
      for (const listener of syncListeners) listener(event.state as RoomSyncState);
    }
  };
  const open = async () => {
    opening = true;
    const currentLease = leaseId;
    const result = (await transport.request({
      workspaceId,
      sessionId,
      leaseId: currentLease,
      method: 'open',
      args: legacySnapshot ? [legacySnapshot] : [],
    })) as SessionOwnerSnapshot;
    if (disposed) {
      void transport
        .request({ workspaceId, sessionId, leaseId, method: 'close', args: [] })
        .catch(() => {});
      throw new Error('Session view closed');
    }
    if (currentLease !== leaseId) throw new Error('Session owner changed during open');
    legacySnapshot = undefined;
    opening = false;
    snapshot = result;
    initialBodies.clear();
    for (const row of result.tail) if (row.state === 'ready') initialBodies.set(row.turn.id, row);
    sequence = result.sequence;
    failure = null;
    if (result.syncState === 'synced') resolveFirstSynced();
    for (const event of buffered.splice(0)) apply(event);
  };
  const stop = transport.subscribe((event) => {
    if (disposed || event.leaseId !== leaseId) return;
    if (event.kind === 'lost') {
      failure = new Error(event.error);
      if (snapshot) snapshot.syncState = 'disconnected';
      for (const listener of syncListeners) listener('disconnected');
      if (!reopening) {
        leaseId = crypto.randomUUID();
        opening = true;
        buffered.length = 0;
        reopening = open()
          .then(async () => {
            if (syncRefs) await call('setSync', [true]);
            for (const listener of stateListeners) listener(snapshot!.state as SessionDocState);
            for (const listener of syncListeners) listener(snapshot!.syncState as RoomSyncState);
            for (const listener of historyListeners)
              listener({ kind: 'structure', from: 0, to: snapshot!.directory.length });
          })
          .catch((error) => {
            failure = error instanceof Error ? error : new Error('Session owner unavailable');
          })
          .finally(() => {
            reopening = null;
          });
      }
      return;
    }
    if (opening) buffered.push(event);
    else apply(event);
  });
  try {
    await open();
  } catch (error) {
    stop();
    void transport
      .request({ workspaceId, sessionId, leaseId, method: 'close', args: [] })
      .catch(() => {});
    throw error;
  }

  const read = <T>(method: SessionOwnerRequest['method'], args: unknown[] = []) =>
    call(method, args) as Promise<T>;
  const bodyReads = new Map<
    string,
    { resolve: (value: SessionTurnRead) => void; reject: (error: unknown) => void }[]
  >();
  const readBody = (id: string): Promise<SessionTurnRead> => {
    const cached = initialBodies.get(id);
    if (cached) {
      initialBodies.delete(id);
      return Promise.resolve(cached);
    }
    return new Promise((resolve, reject) => {
      const first = bodyReads.size === 0;
      const pending = bodyReads.get(id) ?? [];
      pending.push({ resolve, reject });
      bodyReads.set(id, pending);
      if (first)
        queueMicrotask(() => {
          void (async () => {
            const batch = [...bodyReads];
            bodyReads.clear();
            for (let start = 0; start < batch.length; start += 256) {
              const chunk = batch.slice(start, start + 256);
              try {
                const rows = await read<SessionTurnRead[]>('readTurns', [
                  chunk.map(([turnId]) => turnId),
                ]);
                chunk.forEach(([, waiting], index) =>
                  waiting.forEach((p) => p.resolve(rows[index]!))
                );
              } catch (error) {
                for (const [, waiting] of chunk) for (const p of waiting) p.reject(error);
              }
            }
          })();
        });
    });
  };
  let observed = false;
  const readPages = async <T>(
    method: 'readRange' | 'readDirectory',
    from: number,
    to: number
  ): Promise<T[]> => {
    const result: T[] = [];
    for (let start = from; start < to; start += 4096)
      result.push(...(await read<T[]>(method, [start, Math.min(start + 4096, to)])));
    return result;
  };
  const reader: SessionHistoryReader = {
    count: () => read('count'),
    readAt: (at) => read('readAt', [at]),
    readTurn: readBody,
    readRange: (from, to) => readPages('readRange', from, to),
    readDirectory: (from, to) => readPages('readDirectory', from, to),
    readAll: () => read('readAll'),
    readTurnOutput: (id) => read('readTurnOutput', [id]),
    observe(listener) {
      historyListeners.add(listener);
      for (const change of earlyChanges.splice(0)) listener(change);
      const initial = observed
        ? Promise.resolve(reader.count()).then((count) => reader.readDirectory(0, count))
        : Promise.resolve(snapshot!.directory);
      observed = true;
      return {
        initial,
        unsubscribe: () => {
          historyListeners.delete(listener);
        },
      };
    },
  };
  const sessionData: SessionData = {
    sessionId,
    history: { ...reader, readTurn: (id) => read('readTurn', [id]) },
    commands: {
      appendTurn: (turn) => read('appendTurn', [turn]),
      replaceTurn: (id, turn) => read('replaceTurn', [id, turn]),
      respondPermission: (...args) => read('respondPermission', args),
      applyHistoryAction: (action) => read('applyHistoryAction', [action]),
      applyHistoryImport: async (input) => {
        try {
          return await read('applyHistoryImport', [input]);
        } catch (cause) {
          return { status: 'indeterminate', cause };
        }
      },
      replaceEditableTail: async (input) => {
        try {
          const result = await read<
            Awaited<ReturnType<SessionData['commands']['replaceEditableTail']>> & {
              rollbackToken?: string;
            }
          >('replaceEditableTail', [input]);
          if (result.status !== 'accepted') return result;
          const rollback = () => read<void>('rollback', [result.rollbackToken]);
          retain(rollback, result.rollbackToken!);
          return { ...result, rollback };
        } catch (cause) {
          return { status: 'indeterminate', cause };
        }
      },
    },
    snapshots: {
      capture: async () => {
        const result = await read<{ token: string; history: SessionSnapshot['history'] }>(
          'capture'
        );
        const handle = Object.freeze({ history: result.history }) as SessionSnapshot;
        snapshotTokens!.set(handle, result.token);
        retain(handle, result.token);
        return handle;
      },
      copyFrom: async (handle, turns) => {
        const token = snapshotTokens!.get(handle);
        if (!token) throw new Error('History snapshot belongs to another owner connection');
        await call('copyFrom', [token, turns]);
      },
    },
  };
  const initialFrom = precedingUserRangeStart(
    snapshot!.directory.length - INITIAL_CONVERSATION_WINDOW_TURNS,
    (index) => snapshot!.directory[index]?.scalars?.role
  );
  const history = createConversationViewFromReader(reader, {
    sessionId,
    tailKeep: Math.max(INITIAL_CONVERSATION_WINDOW_TURNS, snapshot!.directory.length - initialFrom),
  });
  await history.ready;
  return {
    sessionId,
    roomId: getSessionRoomId(sessionId),
    historyBackend: snapshot!.historyBackend,
    history,
    sessionData,
    firstSynced,
    acquireSync: () => {
      if (disposed) return () => {};
      if (++syncRefs === 1) void call('setSync', [true]).catch(() => {});
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--syncRefs === 0 && !disposed) void call('setSync', [false]).catch(() => {});
      };
    },
    getSyncState: () => (snapshot?.syncState ?? 'disconnected') as RoomSyncState,
    subscribeSyncState: (listener) => {
      syncListeners.add(listener);
      return () => {
        syncListeners.delete(listener);
      };
    },
    getState: () => snapshot!.state as SessionDocState,
    setState: () => {
      throw new Error('Shared session control writes require owner commands');
    },
    subscribe: (listener) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    queueCommands: {
      enqueue: (item) => read('enqueue', [item]),
      remove: (id) => read('removeQueued', [id]),
      update: (id, patch) => read('updateQueued', [id, patch]),
      reorder: (ids) => read('reorderQueued', [ids]),
    },
    waitUntilSynced: async (signal) => {
      if (signal?.aborted) return;
      const token = crypto.randomUUID();
      const cancel = () => {
        void call('cancelSync', [token]).catch(() => {});
      };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        await call('sync', [token]);
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      history.dispose();
      historyListeners.clear();
      stateListeners.clear();
      syncListeners.clear();
      void transport
        .request({ workspaceId, sessionId, leaseId, method: 'close', args: [] })
        .catch(() => {});
    },
  };
}
