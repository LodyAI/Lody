import { z } from 'zod';
import type { SessionId } from '@lody/shared';
import type { SessionDirectoryRow, SessionSnapshot, SessionTurn } from '@lody/shared/session-data';
import type {
  SessionOwnerEvent,
  SessionOwnerRequest,
  SessionOwnerSnapshot,
} from '@lody/shared/session-owner-protocol';
import type { SessionDocStore, WorkspaceRuntime } from '../atoms/runtime';

const position = z.number().int().nonnegative();
const identity = z.string().min(1).max(256);
const range = z.tuple([position, position]).refine(([from, to]) => to >= from && to - from <= 4096);

type Lease = {
  clientId: string;
  id: string;
  entry: Entry;
  releaseSync?: () => void;
  syncWaits: Map<string, AbortController>;
};
type Entry = {
  store: SessionDocStore;
  leases: Set<Lease>;
  sequence: number;
  stop: () => void;
  directory?: Promise<readonly SessionDirectoryRow[]>;
};

/** Desktop's UI author: session documents never migrate into a viewing window. */
export function createSharedSessionOwner(
  runtime: WorkspaceRuntime,
  emit: (event: SessionOwnerEvent) => void,
  generation = crypto.randomUUID()
) {
  const entries = new Map<string, Promise<Entry>>();
  const leases = new Map<string, Lease>();
  const pendingOpens = new Map<string, number>();
  const closedClients = new Set<string>();
  const snapshots = new Map<string, { clientId: string; snapshot: SessionSnapshot }>();
  const rollbacks = new Map<
    string,
    { clientId: string; sessionId: SessionId; run: () => Promise<void>; release: () => void }
  >();
  let disposed = false;
  const inFlight = new Set<Promise<unknown>>();
  const key = (clientId: string, leaseId: string) => `${clientId}:${leaseId}`;

  const load = (sessionId: string, seed?: Uint8Array): Promise<Entry> => {
    let loading = entries.get(sessionId);
    if (loading)
      return loading.then(async (entry) => {
        if (seed) {
          if (!entry.store.doc) throw new Error('Session owner has no control document');
          entry.store.doc.import(seed);
          await runtime.repo.persistDocNow(entry.store.roomId, entry.store.doc);
          entry.directory = undefined;
        }
        return entry;
      });
    loading = runtime.acquireSessionStore(sessionId as SessionId, seed).then(async (store) => {
      if (disposed) {
        runtime.releaseSessionStoreRef(sessionId as SessionId);
        throw new Error('Session owner stopped');
      }
      const entry: Entry = { store, leases: new Set(), sequence: 0, stop: () => {} };
      const publish = (
        event:
          | {
              kind: 'history';
              change: Parameters<Parameters<typeof store.history.subscribe>[0]>[0];
            }
          | { kind: 'state'; state: unknown }
          | { kind: 'sync'; state: string }
      ) => {
        entry.sequence++;
        for (const lease of entry.leases)
          emit({
            ...event,
            clientId: lease.clientId,
            leaseId: lease.id,
            generation,
            sequence: entry.sequence,
          });
      };
      const observation = store.sessionData.history.observe((change) => {
        entry.directory = undefined;
        publish({ kind: 'history', change });
      });
      entry.directory = observation.initial;
      const stopHistory = observation.unsubscribe;
      const stopState = store.subscribe((state) =>
        publish({ kind: 'state', state: serializeControlState(state) })
      );
      const stopSync = store.subscribeSyncState((state) => publish({ kind: 'sync', state }));
      let stopped = false;
      entry.stop = () => {
        if (stopped) return;
        stopped = true;
        if (entries.get(sessionId) === loading) entries.delete(sessionId);
        runtime.releaseSessionStoreRef(store.sessionId);
        stopHistory();
        stopState();
        stopSync();
      };
      await store.history.ready;
      return entry;
    });
    entries.set(sessionId, loading);
    void loading.catch(() => {
      if (entries.get(sessionId) === loading) entries.delete(sessionId);
    });
    return loading;
  };

  const release = (clientId: string, leaseId: string) => {
    const id = key(clientId, leaseId);
    const lease = leases.get(id);
    if (!lease) return;
    leases.delete(id);
    lease.releaseSync?.();
    for (const controller of lease.syncWaits.values()) controller.abort();
    lease.entry.leases.delete(lease);
    if (!lease.entry.leases.size && !pendingOpens.get(lease.entry.store.sessionId))
      lease.entry.stop();
  };

  async function request(clientId: string, req: SessionOwnerRequest): Promise<unknown> {
    if (disposed || closedClients.has(clientId)) throw new Error('Session owner client closed');
    if (req.workspaceId !== runtime.workspaceId)
      throw new Error('Session owner workspace mismatch');
    if (req.method === 'releaseHandle') {
      const token = identity.parse(req.args[0]);
      if (snapshots.get(token)?.clientId === clientId) snapshots.delete(token);
      if (rollbacks.get(token)?.clientId === clientId) {
        rollbacks.get(token)!.release();
        rollbacks.delete(token);
      }
      return null;
    }
    if (req.method === 'close') {
      release(clientId, req.leaseId);
      return null;
    }
    if (req.method === 'open') {
      if (leases.has(key(clientId, req.leaseId))) throw new Error('Session lease already exists');
      pendingOpens.set(req.sessionId, (pendingOpens.get(req.sessionId) ?? 0) + 1);
      let entry: Entry | undefined;
      try {
        entry = await load(
          req.sessionId,
          req.args[0] === undefined ? undefined : z.instanceof(Uint8Array).parse(req.args[0])
        );
        if (disposed || closedClients.has(clientId)) throw new Error('Session owner client closed');
        const lease: Lease = { clientId, id: req.leaseId, entry, syncWaits: new Map() };
        leases.set(key(clientId, req.leaseId), lease);
        entry.leases.add(lease);
        const sequence = entry.sequence;
        entry.directory ??= Promise.resolve(entry.store.sessionData.history.count()).then((count) =>
          entry!.store.sessionData.history.readDirectory(0, count)
        );
        const directory = await entry.directory;
        const tail = await entry.store.sessionData.history.readRange(
          Math.max(0, directory.length - 30),
          directory.length
        );
        return {
          generation,
          sequence,
          directory,
          tail,
          state: serializeControlState(entry.store.getState()),
          syncState: entry.store.getSyncState(),
          historyBackend: entry.store.historyBackend,
        } satisfies SessionOwnerSnapshot;
      } catch (error) {
        release(clientId, req.leaseId);
        throw error;
      } finally {
        const remaining = pendingOpens.get(req.sessionId)! - 1;
        if (remaining) pendingOpens.set(req.sessionId, remaining);
        else {
          pendingOpens.delete(req.sessionId);
          if (entry && !entry.leases.size) entry.stop();
        }
      }
    }
    const lease = leases.get(key(clientId, req.leaseId));
    if (!lease || lease.entry.store.sessionId !== req.sessionId)
      throw new Error('Unknown session lease');
    if (req.method === 'cancelSync') {
      lease.syncWaits.get(identity.parse(req.args[0]))?.abort();
      return null;
    }
    if (req.method === 'setSync') {
      if (z.boolean().parse(req.args[0])) lease.releaseSync ??= lease.entry.store.acquireSync();
      else {
        lease.releaseSync?.();
        lease.releaseSync = undefined;
      }
      return null;
    }
    if (req.method === 'sync') {
      const token = identity.parse(req.args[0]);
      const controller = new AbortController();
      lease.syncWaits.set(token, controller);
      try {
        await runtime.withSessionStore(req.sessionId as SessionId, (store) =>
          store.waitUntilSynced(controller.signal)
        );
      } finally {
        lease.syncWaits.delete(token);
      }
      return null;
    }
    return runtime.withSessionStore(req.sessionId as SessionId, async (store) => {
      const { history, commands } = store.sessionData;
      const args = req.args;
      const execute = async () => {
        switch (req.method) {
          case 'count':
            return history.count();
          case 'readAt':
            return history.readAt(position.parse(args[0]));
          case 'readTurn':
            return history.readTurn(identity.parse(args[0]));
          case 'readTurns':
            return Promise.all(
              z
                .array(identity)
                .max(256)
                .parse(args[0])
                .map((id) => history.readTurn(id))
            );
          case 'readRange': {
            const [from, to] = range.parse(args);
            return history.readRange(from, to);
          }
          case 'readDirectory': {
            const [from, to] = range.parse(args);
            return history.readDirectory(from, to);
          }
          case 'readAll':
            return history.readAll();
          case 'readTurnOutput':
            return history.readTurnOutput(identity.parse(args[0]));
          case 'appendTurn':
            return commands.appendTurn(args[0] as SessionTurn);
          case 'replaceTurn':
            return commands.replaceTurn(identity.parse(args[0]), args[1] as SessionTurn);
          case 'respondPermission':
            return commands.respondPermission(
              ...(args as Parameters<typeof commands.respondPermission>)
            );
          case 'applyHistoryAction':
            return commands.applyHistoryAction(
              args[0] as Parameters<typeof commands.applyHistoryAction>[0]
            );
          case 'applyHistoryImport':
            return commands.applyHistoryImport(
              args[0] as Parameters<typeof commands.applyHistoryImport>[0]
            );
          case 'replaceEditableTail': {
            const result = await commands.replaceEditableTail(
              args[0] as Parameters<typeof commands.replaceEditableTail>[0]
            );
            if (result.status !== 'accepted') return result;
            const token = crypto.randomUUID();
            await runtime.acquireSessionStore(store.sessionId);
            rollbacks.set(token, {
              clientId,
              sessionId: store.sessionId,
              run: result.rollback,
              release: () => runtime.releaseSessionStoreRef(store.sessionId),
            });
            return {
              status: 'accepted',
              previousUserTurnId: result.previousUserTurnId,
              rollbackToken: token,
            };
          }
          case 'rollback': {
            const token = identity.parse(args[0]);
            const rollback = rollbacks.get(token);
            if (
              !rollback ||
              rollback.clientId !== clientId ||
              rollback.sessionId !== store.sessionId
            )
              throw new Error('Unknown rollback');
            rollbacks.delete(token);
            try {
              await rollback.run();
            } finally {
              rollback.release();
            }
            return null;
          }
          case 'capture': {
            const snapshot = await store.sessionData.snapshots.capture();
            const token = crypto.randomUUID();
            snapshots.set(token, { clientId, snapshot });
            return { token, history: snapshot.history };
          }
          case 'copyFrom': {
            const retained = snapshots.get(identity.parse(args[0]));
            if (!retained || retained.clientId !== clientId)
              throw new Error('Unknown history snapshot');
            return store.sessionData.snapshots.copyFrom(
              retained.snapshot,
              args[1] as SessionTurn[]
            );
          }
          case 'enqueue':
            return runtime.writer.enqueueSessionMessage(
              store.sessionId,
              z.record(z.string(), z.unknown()).parse(args[0])
            );
          case 'removeQueued':
            return runtime.writer.removeSessionMessage(store.sessionId, identity.parse(args[0]));
          case 'updateQueued':
            return runtime.writer.updateSessionMessage(
              store.sessionId,
              identity.parse(args[0]),
              z.record(z.string(), z.unknown()).parse(args[1])
            );
          case 'reorderQueued':
            return runtime.writer.reorderSessionMessages(
              store.sessionId,
              z.array(identity).max(10000).parse(args[0])
            );
        }
      };
      const value = await execute();
      if (
        [
          'appendTurn',
          'replaceTurn',
          'respondPermission',
          'applyHistoryAction',
          'applyHistoryImport',
          'replaceEditableTail',
          'rollback',
          'copyFrom',
          'enqueue',
          'removeQueued',
          'updateQueued',
          'reorderQueued',
        ].includes(req.method)
      ) {
        if (!store.doc) throw new Error('Session owner has no control document');
        await runtime.repo.persistDocNow(store.roomId, store.doc);
        if (['enqueue', 'removeQueued', 'updateQueued', 'reorderQueued'].includes(req.method))
          await runtime.repo.persistMetaNow();
      }
      return value;
    });
  }

  function releaseClient(clientId: string) {
    closedClients.add(clientId);
    for (const lease of [...leases.values()])
      if (lease.clientId === clientId) release(clientId, lease.id);
    for (const [token, entry] of snapshots)
      if (entry.clientId === clientId) snapshots.delete(token);
    for (const [token, entry] of rollbacks)
      if (entry.clientId === clientId) {
        entry.release();
        rollbacks.delete(token);
      }
  }

  return {
    request(clientId: string, req: SessionOwnerRequest) {
      const pending = request(clientId, req);
      inFlight.add(pending);
      void pending
        .finally(() => {
          inFlight.delete(pending);
          if (closedClients.has(clientId)) releaseClient(clientId);
        })
        .catch(() => {});
      return pending;
    },
    releaseClient,
    async dispose() {
      disposed = true;
      for (const lease of [...leases.values()]) release(lease.clientId, lease.id);
      await Promise.allSettled([...inFlight]);
      snapshots.clear();
      for (const entry of rollbacks.values()) entry.release();
      rollbacks.clear();
      await runtime.dispose();
    },
  };
}

/** Queue container identity is non-enumerable in Mirror, but must cross IPC. */
export function serializeControlState<T>(state: T): T {
  if (Array.isArray(state)) return state.map(serializeControlState) as T;
  if (!state || typeof state !== 'object') return state;
  const result = Object.fromEntries(
    Object.entries(state).map(([key, value]) => [key, serializeControlState(value)])
  );
  const cid = (state as { $cid?: unknown }).$cid;
  if (typeof cid === 'string') result.$cid = cid;
  return result as T;
}
