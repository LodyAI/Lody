import { useCallback, useEffect, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import {
  getMachineFlockDocId,
  getMachineFlockDeleteLocalProjectEntries,
  getMachineFlockLocalProjects,
  buildMachineDeleteLocalProjectCommand,
  getServerNow,
  machineFlockKeys,
  type LocalProjectId,
  type LocalProjectMeta,
  type MachineId,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom, userAtom } from '@/atoms';
import { getMachineMetaMapAtom } from '@/atoms/machines';
import {
  resyncMachineFlockRows,
  useMachineFlockRowsByMachineIds,
} from '@/hooks/use-machine-flock-rows';
import { getLocalProjectVisibilityKey } from '@/lib/visible-local-project-index';

export type RemoveLocalProjectTarget = {
  machineId: MachineId;
  localProjectId: LocalProjectId;
  projectName?: string;
  originalRootPath?: string;
};

export type PendingLocalProjectRemoval = {
  key: string;
  machineId: MachineId;
  localProjectId: LocalProjectId;
  project: LocalProjectMeta;
  requestedAt: number;
};

/**
 * Pending removal commands remain visible as honest UI state while the owning
 * machine archives Sessions. Normal project selectors continue to use the
 * optimistic machine overlay and therefore cannot start new work against a
 * project that is leaving Lody.
 */
export function usePendingLocalProjectRemovals(
  machineIds: readonly (MachineId | string)[]
): ReadonlyMap<string, PendingLocalProjectRemoval> {
  const rawMachines = useAtomValue(getMachineMetaMapAtom);
  const rowsByMachineId = useMachineFlockRowsByMachineIds(machineIds, {
    families: ['localProject', 'deleteLocalProjectCommand'],
  });

  return useMemo(() => {
    const pending = new Map<string, PendingLocalProjectRemoval>();
    for (const [machineId, rows] of rowsByMachineId) {
      const flockProjects = getMachineFlockLocalProjects(rows);
      const legacyProjects = rawMachines.get(machineId)?.localProjects ?? {};
      for (const [localProjectId, command] of getMachineFlockDeleteLocalProjectEntries(rows)) {
        if (command.status === 'completed') continue;
        const project = flockProjects[localProjectId] ?? legacyProjects[localProjectId];
        if (!project) continue;
        const key = getLocalProjectVisibilityKey(machineId, localProjectId);
        pending.set(key, {
          key,
          machineId,
          localProjectId,
          project,
          requestedAt: command.requestedAt,
        });
      }
    }
    return pending;
  }, [rawMachines, rowsByMachineId]);
}

/** The owning machine decides whether references require retaining the registration. */
export function useRemoveLocalProject() {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const currentUserId = useAtomValue(userAtom)?.id;
  const removeLocalProject = useCallback(
    async (target: RemoveLocalProjectTarget): Promise<boolean> => {
      if (!runtime) return false;
      try {
        await runtime.writer.flockRowPut(
          getMachineFlockDocId(runtime.workspaceId, target.machineId),
          machineFlockKeys.deleteLocalProjectCommand(target.localProjectId),
          buildMachineDeleteLocalProjectCommand({
            requestedAt: getServerNow(),
            requestedBy: currentUserId,
            projectName: target.projectName,
            originalRootPath: target.originalRootPath,
          })
        );
        void resyncMachineFlockRows(runtime, target.machineId).catch(() => undefined);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [runtime, currentUserId]
  );
  return { removeLocalProject };
}

const localProjectRemovalResultNotificationsInFlight = new Set<string>();
// Keep completed projects suppressed while the durable command row is being
// acknowledged and removed. The row is the source of truth for the eventual
// success toast, so a stale landing selection must not race it with an access
// error during that handoff.
const localProjectRemovalCompletionSuppressionKeys = new Set<string>();

export function isLocalProjectRemovalCompletionSuppressed(
  machineId: MachineId | string,
  localProjectId: LocalProjectId | string
): boolean {
  return localProjectRemovalCompletionSuppressionKeys.has(`${machineId}:${localProjectId}`);
}

/** Show and acknowledge durable cleanup results without treating them as pending removal. */
export function useLocalProjectRemovalResultNotifications(
  machineIds: readonly (MachineId | string)[]
): void {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const rowsByMachineId = useMachineFlockRowsByMachineIds(machineIds, {
    families: ['deleteLocalProjectCommand'],
  });

  useEffect(() => {
    if (!runtime) return;
    const completedCommandKeys = new Set<string>();
    for (const [machineId, rows] of rowsByMachineId) {
      for (const [localProjectId, command] of getMachineFlockDeleteLocalProjectEntries(rows)) {
        if (command.status !== 'completed' || !command.cleanupResult) continue;
        const completionKey = `${machineId}:${localProjectId}`;
        completedCommandKeys.add(completionKey);
        const notificationKey = `${machineId}:${localProjectId}:${command.requestedAt}`;
        if (localProjectRemovalResultNotificationsInFlight.has(notificationKey)) continue;
        localProjectRemovalResultNotificationsInFlight.add(notificationKey);
        localProjectRemovalCompletionSuppressionKeys.add(completionKey);
        void (async () => {
          try {
            await runtime.writer.flockRowDelete(
              getMachineFlockDocId(runtime.workspaceId, machineId as MachineId),
              machineFlockKeys.deleteLocalProjectCommand(localProjectId)
            );
            const result = command.cleanupResult!;
            const projectName =
              command.projectName?.trim() || t('sidebar.localProjects.remove.resultFallbackName');
            const keptCount = result.skippedDirty.length + result.failed.length;
            const description =
              keptCount > 0
                ? t('sidebar.localProjects.remove.resultWithKept', {
                    deleted: result.deleted.length,
                    kept: keptCount,
                  })
                : t('sidebar.localProjects.remove.resultAllClean', {
                    count: result.deleted.length,
                  });
            const title = t('sidebar.localProjects.remove.resultTitle', { name: projectName });
            if (keptCount > 0) {
              toast.warning(title, { description });
            } else {
              toast.success(title, { description });
            }
          } catch {
            localProjectRemovalResultNotificationsInFlight.delete(notificationKey);
          }
        })();
      }
    }
    for (const completionKey of localProjectRemovalCompletionSuppressionKeys) {
      if (!completedCommandKeys.has(completionKey)) {
        localProjectRemovalCompletionSuppressionKeys.delete(completionKey);
      }
    }
  }, [rowsByMachineId, runtime, t]);
}
