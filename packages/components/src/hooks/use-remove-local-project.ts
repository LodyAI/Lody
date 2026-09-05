import { resolveActiveAssistantTurnIdFromIndex } from '@/lib/conversation-view';
import { useCallback, useEffect, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  buildMachineDeleteLocalProjectCommand,
  getMachineFlockDocId,
  getMachineFlockDeleteLocalProjectEntries,
  getMachineFlockLocalProjects,
  getServerNow,
  isActiveSessionStatus,
  machineFlockKeys,
  type LocalProjectId,
  type LocalProjectMeta,
  type LocalProjectWorktreeCleanupPreflightResult,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom, currentWorkspaceIdAtom, userAtom } from '@/atoms';
import { getMachineMetaMapAtom } from '@/atoms/machines';
import {
  resyncMachineFlockRows,
  useMachineFlockRowsByMachineIds,
} from '@/hooks/use-machine-flock-rows';
import { useVisibleSessionMetas } from '@/hooks/use-visible-session-metas';
import { useSessionActions } from '@/hooks/use-session-actions';
import { getLocalProjectVisibilityKey } from '@/lib/visible-local-project-index';

export type RemoveLocalProjectTarget = {
  machineId: MachineId;
  localProjectId: LocalProjectId;
  projectName?: string;
  originalRootPath?: string;
};

export type RemoveLocalProjectOptions = {
  cleanupWorktrees?: boolean;
};

export type RemoveLocalProjectImpact = {
  conversationCount: number;
  runningSessionCount: number;
};

export type PendingLocalProjectRemoval = {
  key: string;
  machineId: MachineId;
  localProjectId: LocalProjectId;
  project: LocalProjectMeta;
  requestedAt: number;
};

function isSessionInLocalProject(session: SessionMeta, target: RemoveLocalProjectTarget): boolean {
  const project = session.project;
  return (
    session.machineId === target.machineId &&
    project?.kind === 'local' &&
    project.localProjectId === target.localProjectId
  );
}

export function getRemoveLocalProjectImpactFromSessions(
  sessions: readonly SessionMeta[],
  target: RemoveLocalProjectTarget
): RemoveLocalProjectImpact {
  const matching = sessions.filter((session) => isSessionInLocalProject(session, target));
  return {
    conversationCount: matching.length,
    runningSessionCount: matching.filter((session) => isActiveSessionStatus(session.status)).length,
  };
}

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

/**
 * Shared logic for removing a local project, used by both the desktop sidebar
 * trash affordance and the mobile project-settings screen.
 *
 * Removal is always represented as a durable machine Flock command row. Readers
 * hide the project optimistically while the owning machine applies the command
 * after syncing, even if it is offline when the user confirms.
 *
 * Once the command is committed to the local Flock doc, persistence,
 * active-session cancellation, and remote sync continue in the background. The
 * owning CLI archives the project's sessions before removing the project.
 */
export function useRemoveLocalProject() {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
  const currentUserId = useAtomValue(userAtom)?.id;
  const { allActiveSessions } = useVisibleSessionMetas();
  const { requestSessionCancel } = useSessionActions();

  const getRemoveLocalProjectImpact = useCallback(
    (target: RemoveLocalProjectTarget): RemoveLocalProjectImpact =>
      getRemoveLocalProjectImpactFromSessions(allActiveSessions, target),
    [allActiveSessions]
  );

  const requestStopRunningSessions = useCallback(
    async (target: RemoveLocalProjectTarget): Promise<void> => {
      if (!runtime) return;

      const runningSessions = allActiveSessions.filter(
        (session) =>
          isSessionInLocalProject(session, target) && isActiveSessionStatus(session.status)
      );

      await Promise.all(
        runningSessions.map(async (session) => {
          try {
            const sessionId = session.id as SessionId;
            const activeAssistantTurnId = await runtime.withSessionStore(
              sessionId,
              (sessionStore) => resolveActiveAssistantTurnIdFromIndex(sessionStore.history)
            );
            if (!activeAssistantTurnId) return;
            await requestSessionCancel(sessionId, activeAssistantTurnId);
          } catch (error) {
            console.warn('Failed to request local project session stop', {
              sessionId: session.id,
              error,
            });
          }
        })
      );
    },
    [allActiveSessions, requestSessionCancel, runtime]
  );

  const removeLocalProject = useCallback(
    async (
      target: RemoveLocalProjectTarget,
      options: RemoveLocalProjectOptions = {}
    ): Promise<boolean> => {
      if (!runtime) return false;

      try {
        const requestedAt = getServerNow();
        await runtime.writer.flockRowPut(
          getMachineFlockDocId(runtime.workspaceId, target.machineId),
          machineFlockKeys.deleteLocalProjectCommand(target.localProjectId),
          buildMachineDeleteLocalProjectCommand({
            requestedAt,
            requestedBy: currentUserId,
            projectName: target.projectName,
            originalRootPath: target.originalRootPath,
            cleanupWorktrees: options.cleanupWorktrees,
          })
        );
        void resyncMachineFlockRows(runtime, target.machineId).catch(() => undefined);
        void requestStopRunningSessions(target).catch(() => undefined);

        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [currentUserId, requestStopRunningSessions, runtime]
  );

  const preflightLocalProjectRemoval = useCallback(
    async (
      target: RemoveLocalProjectTarget
    ): Promise<LocalProjectWorktreeCleanupPreflightResult> => {
      if (!runtime || !workspaceId) {
        throw new Error('The workspace is not ready.');
      }
      const response = await runtime.requestLocalProjectControl(
        {
          type: 'local-project/removal-preflight',
          machineId: target.machineId,
          workspaceId,
          localProjectId: target.localProjectId,
          ...(currentUserId ? { requestedByUserId: currentUserId } : {}),
        },
        { timeoutMs: 30_000 }
      );
      if (!response?.ok) {
        throw new Error(response?.message || 'Could not inspect session worktrees.');
      }
      if (response.type !== 'local-project/removal-preflight') {
        throw new Error('The device returned an unexpected worktree inspection result.');
      }
      return response.result;
    },
    [currentUserId, runtime, workspaceId]
  );

  return {
    removeLocalProject,
    preflightLocalProjectRemoval,
    getRemoveLocalProjectImpact,
  };
}

const localProjectRemovalResultNotificationsInFlight = new Set<string>();

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
    for (const [machineId, rows] of rowsByMachineId) {
      for (const [localProjectId, command] of getMachineFlockDeleteLocalProjectEntries(rows)) {
        if (command.status !== 'completed' || !command.cleanupResult) continue;
        const notificationKey = `${machineId}:${localProjectId}:${command.requestedAt}`;
        if (localProjectRemovalResultNotificationsInFlight.has(notificationKey)) continue;
        localProjectRemovalResultNotificationsInFlight.add(notificationKey);
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
  }, [rowsByMachineId, runtime, t]);
}
