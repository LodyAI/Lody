import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { cloudOperations } from '@/lib/cloud-api-operations';
import type { MachineFlockRowFamily, MachineId, WorkspaceId } from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { getMachineMetaMapAtom } from '@/atoms/machines';
import { userAtom } from '@/atoms';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { useMachineFlockRowsByMachineIdsState } from '@/hooks/use-machine-flock-rows';
import {
  canRunAuthedWorkspaceQuery,
  isAuthedWorkspaceQueryLoading,
} from '@/lib/authed-convex-query';
import { mergeMachineFlockMachineMeta } from '@/lib/machine-flock-machine-meta-overlay';
import {
  buildVisibleMachineIndex,
  type MachineVisibilityAccess,
  type VisibleMachineIndex,
} from '@/lib/visible-machine-index';
import { useAuthenticatedConvex } from './use-authenticated-convex';
import { useCloudQuery } from '@lody/platform/react';

export type { MachineVisibilityAccess };

const EMPTY_ACCESS_ROWS: MachineVisibilityAccess[] = [];

type UseVisibleMachineMetasOptions = {
  includeMachineFlock?: boolean;
  syncMachineFlock?: boolean;
  machineFlockFamilies?: readonly MachineFlockRowFamily[];
  workspaceId?: WorkspaceId | null;
  enabled?: boolean;
};

const DEFAULT_MACHINE_FLOCK_FAMILIES = [
  'localProject',
  'deleteLocalProjectCommand',
  'acpCapability',
  'rateLimit',
] as const satisfies readonly MachineFlockRowFamily[];

export type VisibleMachineMetas = VisibleMachineIndex & {
  /** Machine ids backed by real Convex access rows; excludes the local owner fallback. */
  convexAuthorizedMachineIds: ReadonlySet<MachineId>;
  machineFlockRemoteSyncedMachineIds: ReadonlySet<MachineId>;
};

export function useVisibleMachineMetas(
  options: UseVisibleMachineMetasOptions = {}
): VisibleMachineMetas {
  const includeMachineFlock = options.includeMachineFlock ?? true;
  const syncMachineFlock = options.syncMachineFlock ?? true;
  const enabled = options.enabled ?? true;
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const workspaceId = options.workspaceId === undefined ? currentWorkspaceId : options.workspaceId;
  const { isAuthenticated, isLoading: isConvexAuthLoading } = useAuthenticatedConvex();
  const canQuery = enabled && canRunAuthedWorkspaceQuery(workspaceId, isAuthenticated);
  const rawMachines = useAtomValue(getMachineMetaMapAtom);
  const onlineMachineIds = useAtomValue(onlineMachineIdsAtom);
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const queriedAccessRows = useCloudQuery(
    cloudOperations.machines.listVisibleMachines,
    enabled && workspaceId ? { workspaceId } : 'skip'
  );
  const rawAccessRows = enabled ? (queriedAccessRows ?? EMPTY_ACCESS_ROWS) : EMPTY_ACCESS_ROWS;
  const isLoading =
    !enabled ||
    isAuthedWorkspaceQueryLoading({
      workspaceId,
      isConvexAuthLoading,
      canQuery,
      queryResult: queriedAccessRows,
    });

  const baseVisibleIndex = useMemo(
    () =>
      buildVisibleMachineIndex({
        rawMachines,
        convexAccessRows: rawAccessRows,
        currentUserId: enabled ? currentUserId : null,
        isLoading,
      }),
    [enabled, rawMachines, rawAccessRows, currentUserId, isLoading]
  );
  const convexAuthorizedMachineIds = useMemo(
    () => new Set(rawAccessRows.map((row) => row.machineId as MachineId)),
    [rawAccessRows]
  );
  const visibleMachineIds = useMemo(
    () => [...baseVisibleIndex.machines.keys()],
    [baseVisibleIndex.machines]
  );
  const onlineVisibleMachineIds = useMemo(
    () => visibleMachineIds.filter((machineId) => onlineMachineIds.has(machineId)),
    [onlineMachineIds, visibleMachineIds]
  );
  const {
    rowsByMachineId: machineFlockRowsByMachineId,
    remoteSyncedMachineIds: machineFlockRemoteSyncedMachineIds,
  } = useMachineFlockRowsByMachineIdsState(includeMachineFlock ? visibleMachineIds : [], {
    families: options.machineFlockFamilies ?? DEFAULT_MACHINE_FLOCK_FAMILIES,
    syncRemote: syncMachineFlock,
    remoteMachineIds: onlineVisibleMachineIds,
  });
  const visibleMachinesWithFlockMeta = useMemo(
    () =>
      includeMachineFlock
        ? mergeMachineFlockMachineMeta(baseVisibleIndex.machines, machineFlockRowsByMachineId)
        : baseVisibleIndex.machines,
    [baseVisibleIndex.machines, includeMachineFlock, machineFlockRowsByMachineId]
  );

  return useMemo(
    () => ({
      ...baseVisibleIndex,
      convexAuthorizedMachineIds,
      machines: visibleMachinesWithFlockMeta,
      machineFlockRemoteSyncedMachineIds,
    }),
    [
      baseVisibleIndex,
      convexAuthorizedMachineIds,
      machineFlockRemoteSyncedMachineIds,
      visibleMachinesWithFlockMeta,
    ]
  );
}
