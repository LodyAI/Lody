import type { MachineId } from '@lody/shared';
import type { E2eeMachineSharingView } from '@lody/platform';

/**
 * Visibility of other members' machines in an encrypted workspace, derived only from
 * the host's verified machine-sharing view (owner-signed policy + verified ledger,
 * evaluated by core for this member). Ordinary machine tables are never consulted.
 * This grants nothing: the receiving machine still authorizes every execution.
 */
export type EncryptedSharedMachine = {
  /** Owner-signed shared project ids (all-team machine sharing plus project switches). */
  readonly projects: readonly string[];
};
export type EncryptedSharedMachines = ReadonlyMap<MachineId, EncryptedSharedMachine>;

export type EncryptedSharedMachinePort = {
  readMachineSharing(workspaceId: string, machineId: string): Promise<E2eeMachineSharingView>;
};
export type EncryptedSharedMachineTimers = {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

/** Below the owner-approved < 15 minute bound for unknown withdrawal. */
export const ENCRYPTED_SHARED_MACHINE_REFRESH_MS = 10 * 60 * 1000;
const READ_CONCURRENCY = 2;
const EMPTY: EncryptedSharedMachines = new Map();

/** Only a current, verified, permitted view is visible; Guest and denial come from core. */
export function isUsableSharedMachineView(machineId: string, view: E2eeMachineSharingView) {
  return (
    view.machineId === machineId &&
    view.sharedWithTeam &&
    !view.deniedReason &&
    !view.removed &&
    !view.unavailable
  );
}

export function createEncryptedSharedMachineStore(options: {
  workspaceId: string;
  port: EncryptedSharedMachinePort;
  timers?: EncryptedSharedMachineTimers;
  refreshMs?: number;
}) {
  const timers: EncryptedSharedMachineTimers = options.timers ?? {
    setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  };
  let snapshot: EncryptedSharedMachines = EMPTY;
  let candidates = new Set<MachineId>();
  // Each lease contributes its own candidates; the store reads their union, so one
  // consumer disabling or unmounting can withdraw only its own contribution.
  const contributions = new Map<symbol, ReadonlySet<MachineId>>();
  let disposed = false;
  const listeners = new Set<() => void>();
  // Latest read sequence per machine: a slower, older result never overrides a newer one.
  const sequence = new Map<MachineId, number>();
  const queue: MachineId[] = [];
  const queued = new Set<MachineId>();
  let running = 0;

  const publish = (next: Map<MachineId, EncryptedSharedMachine>) => {
    snapshot = next.size === 0 ? EMPTY : next;
    for (const listener of [...listeners]) listener();
  };
  const set = (machineId: MachineId, value: EncryptedSharedMachine | null) => {
    const current = snapshot.get(machineId);
    if (value === null ? !current : current && sameProjects(current.projects, value.projects))
      return;
    const next = new Map(snapshot);
    if (value) next.set(machineId, value);
    else next.delete(machineId);
    publish(next);
  };
  const pump = () => {
    while (!disposed && running < READ_CONCURRENCY && queue.length > 0) {
      const machineId = queue.shift()!;
      queued.delete(machineId);
      const ticket = (sequence.get(machineId) ?? 0) + 1;
      sequence.set(machineId, ticket);
      running += 1;
      void options.port
        .readMachineSharing(options.workspaceId, machineId)
        .then(
          (view) =>
            isUsableSharedMachineView(machineId, view) ? { projects: [...view.projects] } : null,
          // A failed read removes access immediately; it never keeps a stale grant.
          () => null
        )
        .then((value) => {
          if (disposed || sequence.get(machineId) !== ticket || !candidates.has(machineId)) return;
          set(machineId, value);
        })
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  };
  const enqueue = (machineId: MachineId) => {
    if (queued.has(machineId)) return;
    queued.add(machineId);
    queue.push(machineId);
  };
  const refresh = () => {
    if (disposed) return;
    for (const machineId of candidates) enqueue(machineId);
    pump();
  };
  const interval = timers.setInterval(
    refresh,
    options.refreshMs ?? ENCRYPTED_SHARED_MACHINE_REFRESH_MS
  );

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** One lease's machines owned by other members; the union of live leases is read. */
    setCandidates(lease: symbol, machineIds: Iterable<MachineId> | null) {
      if (disposed) return;
      if (machineIds === null) contributions.delete(lease);
      else contributions.set(lease, new Set(machineIds));
      const next = new Set<MachineId>();
      for (const ids of contributions.values()) for (const machineId of ids) next.add(machineId);
      const added = [...next].filter((machineId) => !candidates.has(machineId));
      const removed = [...candidates].filter((machineId) => !next.has(machineId));
      candidates = next;
      if (removed.some((machineId) => snapshot.has(machineId))) {
        const kept = new Map(snapshot);
        for (const machineId of removed) kept.delete(machineId);
        publish(kept);
      }
      for (const machineId of added) enqueue(machineId);
      pump();
    },
    refresh,
    dispose() {
      disposed = true;
      timers.clearInterval(interval);
      listeners.clear();
      queue.length = 0;
      queued.clear();
    },
  };
}
export type EncryptedSharedMachineStore = ReturnType<typeof createEncryptedSharedMachineStore>;

function sameProjects(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** One store per account and workspace, shared by every consumer of the visible index. */
const stores = new Map<string, { store: EncryptedSharedMachineStore; refs: number }>();
export function acquireEncryptedSharedMachineStore(
  key: { accountId: string; workspaceId: string },
  create: () => EncryptedSharedMachineStore
) {
  const id = JSON.stringify([key.accountId, key.workspaceId]);
  let entry = stores.get(id);
  if (!entry) stores.set(id, (entry = { store: create(), refs: 0 }));
  entry.refs += 1;
  const owned = entry;
  const lease = Symbol('encrypted-shared-machine-lease');
  let released = false;
  return {
    store: owned.store,
    /** No-op once released: a stale consumer can never rewrite live candidates. */
    setCandidates(machineIds: Iterable<MachineId>) {
      if (!released) owned.store.setCandidates(lease, machineIds);
    },
    release() {
      if (released) return;
      released = true;
      owned.store.setCandidates(lease, null);
      owned.refs -= 1;
      if (owned.refs === 0 && stores.get(id) === owned) {
        stores.delete(id);
        owned.store.dispose();
      }
    },
  };
}
