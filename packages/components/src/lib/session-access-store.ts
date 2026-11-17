import type { SessionAccessPort, SessionAccessView } from '@lody/platform';

export type SessionAccessSnapshot = {
  readonly views: ReadonlyMap<string, SessionAccessView>;
  readonly loading: boolean;
};
export const EMPTY_SESSION_ACCESS: SessionAccessSnapshot = { views: new Map(), loading: false };

/** One account/workspace lease. Version notifications are hints; only port reads publish grants.
 * Superseded requests cannot restore withdrawn grants. Failed reads remain retryable.
 */
export function createSessionAccessStore(port: SessionAccessPort, workspaceId: string) {
  let snapshot: SessionAccessSnapshot = { views: new Map(), loading: true };
  let sequence = 0;
  let disposed = false;
  let listTicket = 0;
  const machineTickets = new Map<string, number>();
  const completedMachineTickets = new Map<string, number>();
  const listeners = new Set<() => void>();
  let subscribed = false;
  let unsubscribe = () => {};
  const ensureSubscribed = () => {
    if (disposed) throw new Error('session_access_superseded');
    if (subscribed) return;
    // Mark first: synchronous initial notifications must not recursively subscribe.
    subscribed = true;
    try {
      unsubscribe = port.subscribe(workspaceId, () => {
        void refresh();
      });
    } catch (error) {
      subscribed = false;
      throw error;
    }
  };
  const publish = (value: SessionAccessSnapshot) => {
    snapshot = value;
    for (const listener of listeners) listener();
  };
  const refresh = async () => {
    const ticket = ++sequence;
    listTicket = ticket;
    for (const id of machineTickets.keys()) machineTickets.set(id, ticket);
    try {
      ensureSubscribed();
      const views = await port.list(workspaceId);
      if (!disposed && ticket === listTicket) {
        const next = new Map(views.map((view) => [view.machineId, view]));
        for (const [id, completed] of completedMachineTickets) {
          if (completed <= ticket) continue;
          const current = snapshot.views.get(id);
          if (current) next.set(id, current);
          else next.delete(id);
        }
        publish({ views: next, loading: false });
      }
    } catch {
      if (!disposed && ticket === listTicket) {
        const next = new Map(
          [...snapshot.views].filter(([id]) => (completedMachineTickets.get(id) ?? 0) > ticket)
        );
        publish({ views: next, loading: false });
      }
    }
  };
  const read = async (machineId: string) => {
    const ticket = ++sequence;
    machineTickets.set(machineId, ticket);
    try {
      ensureSubscribed();
      const view = await port.read(workspaceId, machineId);
      if (disposed || ticket !== machineTickets.get(machineId))
        throw new Error('session_access_superseded');
      completedMachineTickets.set(machineId, ticket);
      {
        const views = new Map(snapshot.views);
        views.set(machineId, view);
        publish({ views, loading: false });
      }
      return view;
    } catch (error) {
      if (!disposed && ticket === machineTickets.get(machineId)) {
        completedMachineTickets.set(machineId, ticket);
        const views = new Map(snapshot.views);
        views.delete(machineId);
        publish({ views, loading: false });
      }
      throw error;
    }
  };
  // Subscribe before the first read so a live version hint cannot be lost.
  void refresh();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    read,
    dispose() {
      disposed = true;
      ++sequence;
      unsubscribe();
      listeners.clear();
    },
  };
}
export type SessionAccessStore = ReturnType<typeof createSessionAccessStore>;
const stores = new WeakMap<
  SessionAccessPort,
  Map<string, { store: SessionAccessStore; refs: number }>
>();
export function acquireSessionAccessStore(
  port: SessionAccessPort,
  accountId: string,
  workspaceId: string
) {
  let byScope = stores.get(port);
  if (!byScope) {
    byScope = new Map();
    stores.set(port, byScope);
  }
  const key = JSON.stringify([accountId, workspaceId]);
  let entry = byScope.get(key);
  if (!entry) {
    entry = { store: createSessionAccessStore(port, workspaceId), refs: 0 };
    byScope.set(key, entry);
  }
  entry.refs++;
  let released = false;
  return {
    store: entry.store,
    release() {
      if (released) return;
      released = true;
      if (--entry.refs === 0) {
        entry.store.dispose();
        byScope.delete(key);
      }
    },
  };
}
