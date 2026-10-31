import { useLegacyWorkspaceQuery } from '@/hooks/use-legacy-workspace-query';
import { useLegacyWorkspaceQueryStatus } from './use-workspace-feature';
import { useMemo } from 'react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import type { WorkspaceId } from '@lody/shared';
import { useWorkspaceLocalAccountId } from '@/lib/e2ee-account';
import {
  canRunAuthedWorkspaceQuery,
  isAuthedWorkspaceQueryLoading,
} from '@/lib/authed-convex-query';
import {
  buildVisibleLocalProjectIndex,
  type LocalProjectVisibilityAccess,
  type VisibleLocalProjectIndex,
} from '@/lib/visible-local-project-index';
import { useVisibleMachineMetas } from './use-visible-machine-metas';
import type { VisibleMachineIndex } from '@/lib/visible-machine-index';
import { useAuthenticatedConvex } from './use-authenticated-convex';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';

export type { LocalProjectVisibilityAccess };

const EMPTY_ACCESS_ROWS: LocalProjectVisibilityAccess[] = [];

type UseVisibleLocalProjectsOptions = {
  includeMemberOnly?: boolean;
  includeMachineFlock?: boolean;
  syncMachineFlock?: boolean;
  workspaceId?: WorkspaceId | null;
  enabled?: boolean;
};

export function useVisibleLocalProjects(
  options: UseVisibleLocalProjectsOptions = {}
): VisibleLocalProjectIndex {
  const visibleMachineIndex = useVisibleMachineMetas({
    includeMachineFlock: options.includeMachineFlock,
    syncMachineFlock: options.syncMachineFlock,
    workspaceId: options.workspaceId,
    enabled: options.enabled,
  });
  return useVisibleLocalProjectsFromMachineIndex(visibleMachineIndex, {
    workspaceId: options.workspaceId,
    enabled: options.enabled,
    includeMemberOnly: options.includeMemberOnly,
  });
}

export function useVisibleLocalProjectsFromMachineIndex(
  visibleMachineIndex: Pick<
    VisibleMachineIndex,
    'machines' | 'accessByMachineId' | 'isLoading' | 'sharedProjectIdsByMachineId'
  >,
  options: { enabled?: boolean; workspaceId?: WorkspaceId | null; includeMemberOnly?: boolean } = {}
): VisibleLocalProjectIndex {
  const { workspaceId, enabled } = useResolvedWorkspaceScope(options);
  const { isAuthenticated, isLoading: isConvexAuthLoading } = useAuthenticatedConvex();
  const legacyQueryStatus = useLegacyWorkspaceQueryStatus(workspaceId);
  const legacyQueriesEnabled = legacyQueryStatus === 'allowed';
  const canQuery =
    enabled && legacyQueriesEnabled && canRunAuthedWorkspaceQuery(workspaceId, isAuthenticated);
  const currentUserId = useWorkspaceLocalAccountId();
  const {
    machines: visibleMachines,
    accessByMachineId,
    isLoading: machineVisibilityLoading,
  } = visibleMachineIndex;
  const queriedAccessRows = useLegacyWorkspaceQuery(
    cloudOperations.localProjects.listVisibleLocalProjects,
    enabled && legacyQueriesEnabled && workspaceId ? { workspaceId } : 'skip'
  );
  const sharedProjectIdsByMachineId = visibleMachineIndex.sharedProjectIdsByMachineId;
  const rawAccessRows = useMemo(() => {
    if (!enabled) return EMPTY_ACCESS_ROWS;
    const ordinary = legacyQueriesEnabled
      ? (queriedAccessRows ?? EMPTY_ACCESS_ROWS)
      : EMPTY_ACCESS_ROWS;
    if (!sharedProjectIdsByMachineId?.size) return ordinary;
    // Encrypted: only projects listed in the owner-signed policy of a visible shared machine.
    const shared: LocalProjectVisibilityAccess[] = [];
    for (const [machineId, projectIds] of sharedProjectIdsByMachineId) {
      const access = accessByMachineId.get(machineId);
      if (!access) continue;
      for (const localProjectId of projectIds)
        shared.push({
          machineId,
          localProjectId,
          ownerUserId: access.ownerUserId,
          sharedWithTeam: true,
          updatedAt: 1,
        });
    }
    return [...ordinary, ...shared];
  }, [
    accessByMachineId,
    enabled,
    legacyQueriesEnabled,
    queriedAccessRows,
    sharedProjectIdsByMachineId,
  ]);
  const isLoading =
    enabled &&
    (machineVisibilityLoading ||
      legacyQueryStatus === 'pending' ||
      (legacyQueriesEnabled &&
        isAuthedWorkspaceQueryLoading({
          workspaceId,
          isConvexAuthLoading,
          canQuery,
          queryResult: queriedAccessRows,
        })));

  return useMemo(
    () =>
      buildVisibleLocalProjectIndex({
        rawMachines: visibleMachines,
        machineAccessByMachineId: accessByMachineId,
        convexAccessRows: rawAccessRows,
        currentUserId: enabled ? currentUserId : null,
        isLoading,
        includeMemberOnly: options.includeMemberOnly,
      }),
    [
      accessByMachineId,
      currentUserId,
      enabled,
      isLoading,
      rawAccessRows,
      visibleMachines,
      options.includeMemberOnly,
    ]
  );
}
