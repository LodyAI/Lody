import { useLegacyWorkspaceMutation } from '@/hooks/use-legacy-workspace-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { cloudOperations } from '@/lib/cloud-api-operations';
import {
  getMachineRoomId,
  isLoroRepoDocDeleted,
  type MachineId,
  type MachineMeta,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { evaluateMachineDeletion, prepareMachineForDeletion } from '@/lib/machine-deletion';
import { useAppCapability } from '@/lib/app-platform';

export function useMachineActions(params: {
  currentUserId: string | null;
  localMachineId: MachineId | null;
  canManageAllMachines: boolean;
}) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const onlineMachineIds = useAtomValue(onlineMachineIdsAtom);
  const teamSharingAvailable = useAppCapability('teamSharing');
  const setMachineSharedWithTeam = useLegacyWorkspaceMutation(
    cloudOperations.machines.setMachineSharedWithTeam
  );

  const renameMachine = useCallback(
    async (machineId: MachineId, newName: string) => {
      if (!runtime) return;
      const trimmed = newName.trim();
      if (!trimmed) return;
      const machineRoomId = getMachineRoomId(machineId);
      await runtime.writer.upsertDocMeta(machineRoomId, { name: trimmed });
    },
    [runtime]
  );

  const deleteMachine = useCallback(
    async (machine: MachineMeta) => {
      if (!runtime) {
        throw new Error(
          t('workspace.machines.deleteRuntimeUnavailable', 'Workspace connection is not ready yet.')
        );
      }
      const machineRoomId = getMachineRoomId(machine.id);
      const latestRecord = await runtime.repo.getDocMeta(machineRoomId);
      if (latestRecord && isLoroRepoDocDeleted(latestRecord)) {
        return;
      }

      const machineForDeletion = prepareMachineForDeletion({
        machine,
        latestMeta: latestRecord?.meta as Partial<MachineMeta> | undefined,
      });
      const deletion = evaluateMachineDeletion({
        machine: machineForDeletion,
        isOnline: onlineMachineIds.has(machine.id),
        currentUserId: params.currentUserId,
        localMachineId: params.localMachineId,
        canManageAllMachines: params.canManageAllMachines,
      });
      if (deletion.type === 'online') {
        throw new Error(
          t(
            'workspace.machines.deleteOnlineBlocked',
            'This machine is online. Stop it first before deleting it.'
          )
        );
      }
      if (deletion.type === 'notAllowed') {
        throw new Error(
          t(
            'workspace.machines.deleteNotAllowed',
            'You can only delete offline machines that you own, unless you are an admin or owner.'
          )
        );
      }
      await runtime.writer.deleteDoc(machineRoomId);
    },
    [
      runtime,
      onlineMachineIds,
      t,
      params.currentUserId,
      params.localMachineId,
      params.canManageAllMachines,
    ]
  );

  const setSharedWithTeam = useCallback(
    async (machineId: MachineId, sharedWithTeam: boolean) => {
      // Sharing is a cloud (Convex) surface; without the capability the toggle
      // is hidden, so this is a logic-gate backstop, not a user-visible path.
      if (!teamSharingAvailable) {
        throw new Error(
          t('workspace.machines.shareUnavailableLocal', 'Sharing is not available on this build.')
        );
      }
      if (!workspaceId) {
        throw new Error(
          t('workspace.machines.shareWorkspaceUnavailable', 'Workspace is not ready.')
        );
      }
      await setMachineSharedWithTeam({
        workspaceId,
        machineId,
        sharedWithTeam,
      });
    },
    [setMachineSharedWithTeam, t, teamSharingAvailable, workspaceId]
  );

  return {
    renameMachine,
    deleteMachine,
    setSharedWithTeam,
  };
}
