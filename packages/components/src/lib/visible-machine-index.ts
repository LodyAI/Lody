import type { MachineId, MachineViewMeta } from '@lody/shared';

export type MachineVisibilityAccess = {
  machineId: string;
  ownerUserId: string;
  sharedWithTeam: boolean;
  /**
   * `updatedAt` as returned by Convex `workspaceMachines`. For rows synthesized locally under
   * BC-2026-04-16-MACHINE-VISIBILITY-OWNER-FALLBACK this is `0` (sentinel for "unknown"): the
   * record has no real last-updated time because it never reached Convex.
   */
  updatedAt: number;
};

type BuildArgs = {
  rawMachines: Map<MachineId, MachineViewMeta>;
  convexAccessRows: ReadonlyArray<MachineVisibilityAccess>;
  currentUserId: string | null;
  isLoading: boolean;
};

export type VisibleMachineIndex = {
  machines: Map<MachineId, MachineViewMeta>;
  accessByMachineId: Map<MachineId, MachineVisibilityAccess>;
  isLoading: boolean;
  /** Encrypted only: owner-signed shared project ids of other members' visible machines. */
  sharedProjectIdsByMachineId?: ReadonlyMap<MachineId, readonly string[]>;
};

function selectAccessRow(
  current: MachineVisibilityAccess | undefined,
  next: MachineVisibilityAccess
): MachineVisibilityAccess {
  if (!current) return next;
  return next.updatedAt > current.updatedAt ? next : current;
}

/**
 * Build the visible-machine index exposed by `useVisibleMachineMetas`.
 *
 * BC-2026-04-16-MACHINE-VISIBILITY-OWNER-FALLBACK:
 * Machines introduced in PR #1806 require a `workspaceMachines` row to be visible. Older CLI
 * versions never write that row, so their owners' own machines (and sessions) disappear from the
 * UI until the CLI is upgraded and restarted. This helper additionally synthesizes an implicit
 * `own+private` access entry for any machine whose Loro-recorded `ownerUserId` matches the
 * current user but which has no Convex row yet. Other users' unregistered machines remain hidden,
 * so the visibility contract between members is not weakened.
 */
export function buildVisibleMachineIndex({
  rawMachines,
  convexAccessRows,
  currentUserId,
  isLoading,
}: BuildArgs): VisibleMachineIndex {
  // Apply the privacy filter in both loading and settled states: passing raw
  // Loro machines through during the Convex load window leaks teammates'
  // unshared machines for a few frames on refresh. While loading we simply
  // have no `convexAccessRows` yet, so only the BC owner-fallback entries
  // below are populated — teammates' shared machines show up once the query
  // resolves. Consumers still read `isLoading` to gate destructive UI.
  const accessByMachineId = new Map<MachineId, MachineVisibilityAccess>();
  for (const row of convexAccessRows) {
    const machineId = row.machineId as MachineId;
    accessByMachineId.set(machineId, selectAccessRow(accessByMachineId.get(machineId), row));
  }

  if (currentUserId) {
    for (const [machineId, meta] of rawMachines) {
      if (accessByMachineId.has(machineId)) continue;
      if (meta.ownerUserId !== currentUserId) continue;
      accessByMachineId.set(machineId, {
        machineId,
        ownerUserId: currentUserId,
        sharedWithTeam: false,
        updatedAt: 0,
      });
    }
  }

  const machines = new Map<MachineId, MachineViewMeta>();
  for (const machineId of accessByMachineId.keys()) {
    const machine = rawMachines.get(machineId);
    const access = accessByMachineId.get(machineId);
    if (machine) {
      machines.set(
        machineId,
        access && access.ownerUserId !== machine.ownerUserId
          ? { ...machine, ownerUserId: access.ownerUserId }
          : machine
      );
    }
  }

  return {
    machines,
    accessByMachineId,
    isLoading,
  };
}

/**
 * Encrypted shared machines are exposed for selection and execution only. Surfaces
 * that write to a machine's catalog automatically or need ordinary machine RPC
 * (fenced in encrypted workspaces) use this view of the index.
 */
export function withoutEncryptedSharedMachines<A>(
  machines: ReadonlyMap<MachineId, A>,
  index: Pick<VisibleMachineIndex, 'sharedProjectIdsByMachineId'>
): Map<MachineId, A> {
  const shared = index.sharedProjectIdsByMachineId;
  return new Map([...machines].filter(([machineId]) => !shared?.has(machineId)));
}
