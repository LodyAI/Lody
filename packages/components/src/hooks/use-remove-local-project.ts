import { nativeMachineCatalogSettingsAtom } from '@/atoms/native-machine-catalog';
import { nativeMachineCatalogSettingsForWrite } from '@/lib/native-machine-catalog-public';
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
import type { WorkspaceRuntime } from '@/atoms/runtime';
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
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const nativeCatalog = useAtomValue(nativeMachineCatalogSettingsAtom);
  const rowsByMachineId = useMachineFlockRowsByMachineIds(machineIds, {
    families: ['localProject', 'deleteLocalProjectCommand'],
  });

  return useMemo(() => {
    const pending = new Map<string, PendingLocalProjectRemoval>();
    for (const id of machineIds) {
      const machineId = id as MachineId;
      if (!runtime?.ownsNativeMachineCatalog?.(machineId)) continue;
      const state = runtime.nativeMachineCatalogSource?.readProjection(machineId);
      if (!state?.synced) continue;
      for (const command of state.projection.localProjectDeletions ?? []) {
        if (command.completed) continue;
        const project = state.projection.projects.find((value) => value.id === command.projectId);
        if (!project) continue;
        const key = getLocalProjectVisibilityKey(machineId, project.id);
        pending.set(key, {
          key,
          machineId,
          localProjectId: project.id as LocalProjectId,
          project: { ...project, id: project.id as LocalProjectId },
          requestedAt: command.requestedAt,
        });
      }
    }
    for (const [machineId, rows] of rowsByMachineId) {
      if (runtime?.ownsNativeMachineCatalog?.(machineId as MachineId)) continue;
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
  }, [rawMachines, rowsByMachineId, runtime, nativeCatalog, machineIds]);
}

export async function requestLocalProjectRemoval(
  runtime: WorkspaceRuntime,
  target: RemoveLocalProjectTarget,
  requestedBy?: string
): Promise<void> {
  const command = buildMachineDeleteLocalProjectCommand({
    requestedAt: getServerNow(),
    requestedBy,
    projectName: target.projectName,
    originalRootPath: target.originalRootPath,
  });
  const catalog = nativeMachineCatalogSettingsForWrite(runtime, target.machineId);
  if (catalog)
    await catalog.execute(target.machineId, {
      kind: 'delete-local-project',
      projectId: target.localProjectId,
      command,
    });
  else {
    await runtime.writer.flockRowPut(
      getMachineFlockDocId(runtime.workspaceId, target.machineId),
      machineFlockKeys.deleteLocalProjectCommand(target.localProjectId),
      command
    );
    void resyncMachineFlockRows(runtime, target.machineId).catch(() => undefined);
  }
}

/** The owning machine decides whether references require retaining the registration. */
export function useRemoveLocalProject() {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const currentUserId = useAtomValue(userAtom)?.id;
  const removeLocalProject = useCallback(
    async (target: RemoveLocalProjectTarget): Promise<boolean> => {
      if (!runtime) return false;
      try {
        await requestLocalProjectRemoval(runtime, target, currentUserId);
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

  const nativeCatalog = useAtomValue(nativeMachineCatalogSettingsAtom);
  useEffect(() => {
    if (!runtime) return;
    const notices: {
      machineId: MachineId;
      projectId: LocalProjectId;
      projectName?: string;
      completedAt: number;
      notificationKey: string;
      deletedCount: number;
      keptCount: number;
      native: boolean;
    }[] = [];
    for (const id of machineIds) {
      const machineId = id as MachineId;
      if (!runtime.ownsNativeMachineCatalog?.(machineId)) continue;
      const state = runtime.nativeMachineCatalogSource?.readProjection(machineId);
      if (!state?.synced) continue;
      for (const result of state.projection.localProjectDeletionResults)
        notices.push({
          machineId,
          projectId: result.projectId as LocalProjectId,
          projectName: result.projectName,
          completedAt: result.completedAt,
          notificationKey: `${machineId}:${result.projectId}:native:${result.completedAt}`,
          deletedCount: result.deletedCount,
          keptCount: result.skippedDirtyCount + result.failedCount,
          native: true,
        });
    }
    for (const [machineId, rows] of rowsByMachineId) {
      if (runtime.ownsNativeMachineCatalog?.(machineId as MachineId)) continue;
      for (const [projectId, command] of getMachineFlockDeleteLocalProjectEntries(rows)) {
        const result = command.cleanupResult;
        if (command.status !== 'completed' || !result) continue;
        notices.push({
          machineId: machineId as MachineId,
          projectId,
          projectName: command.projectName,
          completedAt: result.completedAt,
          notificationKey: `${machineId}:${projectId}:${command.requestedAt}`,
          deletedCount: result.deleted.length,
          keptCount: result.skippedDirty.length + result.failed.length,
          native: false,
        });
      }
    }
    const completedCommandKeys = new Set<string>();
    for (const notice of notices) {
      const completionKey = `${notice.machineId}:${notice.projectId}`;
      completedCommandKeys.add(completionKey);
      if (localProjectRemovalResultNotificationsInFlight.has(notice.notificationKey)) continue;
      localProjectRemovalResultNotificationsInFlight.add(notice.notificationKey);
      localProjectRemovalCompletionSuppressionKeys.add(completionKey);
      void (async () => {
        try {
          if (notice.native) {
            const catalog = nativeMachineCatalogSettingsForWrite(runtime, notice.machineId);
            if (!catalog) throw new Error('Native project owner changed');
            await catalog.execute(notice.machineId, {
              kind: 'dismiss-local-project-deletion',
              projectId: notice.projectId,
              completedAt: notice.completedAt,
            });
          } else
            await runtime.writer.flockRowDelete(
              getMachineFlockDocId(runtime.workspaceId, notice.machineId),
              machineFlockKeys.deleteLocalProjectCommand(notice.projectId)
            );
          const projectName =
            notice.projectName?.trim() || t('sidebar.localProjects.remove.resultFallbackName');
          const description =
            notice.keptCount > 0
              ? t('sidebar.localProjects.remove.resultWithKept', {
                  deleted: notice.deletedCount,
                  kept: notice.keptCount,
                })
              : t('sidebar.localProjects.remove.resultAllClean', { count: notice.deletedCount });
          const title = t('sidebar.localProjects.remove.resultTitle', { name: projectName });
          if (notice.keptCount > 0) toast.warning(title, { description });
          else toast.success(title, { description });
        } catch {
          localProjectRemovalResultNotificationsInFlight.delete(notice.notificationKey);
        }
      })();
    }
    for (const completionKey of localProjectRemovalCompletionSuppressionKeys) {
      if (!completedCommandKeys.has(completionKey)) {
        localProjectRemovalCompletionSuppressionKeys.delete(completionKey);
      }
    }
  }, [rowsByMachineId, runtime, t, nativeCatalog, machineIds]);
}
