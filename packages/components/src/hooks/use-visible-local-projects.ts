import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { cloudOperations } from '@/lib/cloud-api-operations';
import type { WorkspaceId } from '@lody/shared';
import { userAtom } from '@/atoms';
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
import { useCloudQuery } from '@lody/platform/react';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';

export type { LocalProjectVisibilityAccess };

const EMPTY_ACCESS_ROWS: LocalProjectVisibilityAccess[] = [];

type UseVisibleLocalProjectsOptions = {
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
  });
}

export function useVisibleLocalProjectsFromMachineIndex(
  visibleMachineIndex: Pick<VisibleMachineIndex, 'machines' | 'accessByMachineId' | 'isLoading'>,
  options: { enabled?: boolean; workspaceId?: WorkspaceId | null } = {}
): VisibleLocalProjectIndex {
  const { workspaceId, enabled } = useResolvedWorkspaceScope(options);
  const { isAuthenticated, isLoading: isConvexAuthLoading } = useAuthenticatedConvex();
  const canQuery = enabled && canRunAuthedWorkspaceQuery(workspaceId, isAuthenticated);
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const {
    machines: visibleMachines,
    accessByMachineId,
    isLoading: machineVisibilityLoading,
  } = visibleMachineIndex;
  const queriedAccessRows = useCloudQuery(
    cloudOperations.localProjects.listVisibleLocalProjects,
    enabled && workspaceId ? { workspaceId } : 'skip'
  );
  const rawAccessRows = queriedAccessRows ?? EMPTY_ACCESS_ROWS;
  const isLoading =
    enabled &&
    (machineVisibilityLoading ||
      isAuthedWorkspaceQueryLoading({
        workspaceId,
        isConvexAuthLoading,
        canQuery,
        queryResult: queriedAccessRows,
      }));

  return useMemo(
    () =>
      buildVisibleLocalProjectIndex({
        rawMachines: visibleMachines,
        machineAccessByMachineId: accessByMachineId,
        convexAccessRows: rawAccessRows,
        currentUserId: enabled ? currentUserId : null,
        isLoading,
      }),
    [accessByMachineId, currentUserId, enabled, isLoading, rawAccessRows, visibleMachines]
  );
}
