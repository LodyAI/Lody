import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { useCloudMutation } from '@lody/platform/react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
import { currentWorkspaceIdAtom, userAtom } from '@/atoms';
import { useVisibleLocalProjects } from '@/hooks/use-visible-local-projects';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import {
  getSessionSharingProjectKey,
  resolveSessionSharingState,
  shouldShowSessionSharing,
  type SessionSharingState,
} from '@/lib/session-sharing';
import { useAuthClient } from '../providers/convex-provider';
import { useAppCapability } from '@/lib/app-platform';

type UseSessionSharingOptions = {
  includeLocalProjectDetails?: boolean;
  workspaceId?: WorkspaceId | null;
  enabled?: boolean;
};

/**
 * Team sharing is a cloud surface. On the local (open-source) platform there is
 * no team and no Better Auth backend, so return `null` without ever invoking
 * the Better Auth hook — `shouldShowSessionSharing` then hides every sharing
 * affordance. Capabilities are immutable for a mounted PlatformProvider, so
 * hook order stays stable across renders.
 */
function useSessionSharingActiveOrganization(teamSharingAvailable: boolean) {
  if (!teamSharingAvailable) {
    return null;
  }
  // oxlint-disable-next-line rules-of-hooks
  const authClient = useAuthClient();
  // oxlint-disable-next-line rules-of-hooks
  const { data } = authClient.useActiveOrganization();
  return data ?? null;
}

export function useSessionSharing(options: UseSessionSharingOptions = {}) {
  const teamSharingAvailable = useAppCapability('teamSharing');
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const workspaceId = options.workspaceId === undefined ? currentWorkspaceId : options.workspaceId;
  const enabled = options.enabled ?? true;
  const activeOrganization = useSessionSharingActiveOrganization(teamSharingAvailable);
  const machineIndex = useVisibleMachineMetas({
    includeMachineFlock: false,
    workspaceId,
    enabled,
  });
  const projectIndex = useVisibleLocalProjects({
    includeMachineFlock: options.includeLocalProjectDetails ?? false,
    syncMachineFlock: false,
    workspaceId,
    enabled,
  });
  const { machines, accessByMachineId, isLoading: machineVisibilityLoading } = machineIndex;
  const { projects, accessByProjectKey, isLoading: localProjectVisibilityLoading } = projectIndex;
  const setMachineSharedWithTeam = useCloudMutation(
    cloudOperations.machines.setMachineSharedWithTeam
  );
  const setLocalProjectSharedWithTeam = useCloudMutation(
    cloudOperations.localProjects.setLocalProjectSharedWithTeam
  );
  const isLoading = machineVisibilityLoading || localProjectVisibilityLoading;
  const showSessionSharing =
    enabled &&
    teamSharingAvailable &&
    shouldShowSessionSharing({
      workspaceId,
      activeWorkspaceId: activeOrganization?.id ?? null,
      memberCount: activeOrganization?.members.length ?? null,
    });

  const resolve = useCallback(
    (session: SessionMeta): SessionSharingState => {
      const machine = machines.get(session.machineId);
      const localProjectId =
        session.project?.kind === 'local' ? session.project.localProjectId : null;
      const project = localProjectId
        ? projects.get(getSessionSharingProjectKey(session.machineId, localProjectId))?.project
        : null;

      return resolveSessionSharingState({
        session,
        currentUserId,
        machineAccessByMachineId: accessByMachineId,
        localProjectAccessByKey: accessByProjectKey,
        machineName: machine?.name,
        projectName: project?.name,
        isLoading,
      });
    },
    [accessByMachineId, accessByProjectKey, currentUserId, isLoading, machines, projects]
  );

  const shareWithTeam = useCallback(
    async (state: SessionSharingState): Promise<void> => {
      if (!workspaceId) {
        throw new Error('Workspace is not ready');
      }
      if (!state.machineId) {
        throw new Error('Session machine is unavailable');
      }
      if (state.privateReason === 'machine-not-registered') {
        throw new Error('Register this device before sharing');
      }
      if (!state.canManage) {
        throw new Error('Only the device owner can change sharing');
      }

      if (state.localProjectId) {
        // This mutation also shares the machine in the same backend
        // transaction. A local project needs both grants before teammates can
        // open or continue its conversations.
        await setLocalProjectSharedWithTeam({
          workspaceId,
          machineId: state.machineId,
          localProjectId: state.localProjectId,
          sharedWithTeam: true,
        });
        return;
      }

      await setMachineSharedWithTeam({
        workspaceId,
        machineId: state.machineId,
        sharedWithTeam: true,
      });
    },
    [setLocalProjectSharedWithTeam, setMachineSharedWithTeam, workspaceId]
  );

  return {
    machines,
    accessByMachineId,
    projects,
    accessByProjectKey,
    machineVisibilityLoading,
    localProjectVisibilityLoading,
    isLoading,
    showSessionSharing,
    resolve,
    shareWithTeam,
  };
}
