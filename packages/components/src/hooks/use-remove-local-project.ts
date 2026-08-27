import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { toast } from 'sonner';
import {
  buildMachineDeleteLocalProjectCommand,
  getMachineFlockDocId,
  getServerNow,
  isActiveSessionStatus,
  machineFlockKeys,
  resolveActiveAssistantTurnId,
  type LocalProjectId,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom, userAtom } from '@/atoms';
import { resyncMachineFlockRows } from '@/hooks/use-machine-flock-rows';
import { useVisibleSessionMetas } from '@/hooks/use-visible-session-metas';
import { useSessionActions } from '@/hooks/use-session-actions';

export type RemoveLocalProjectTarget = {
  machineId: MachineId;
  localProjectId: LocalProjectId;
};

export type RemoveLocalProjectImpact = {
  runningSessionCount: number;
};

function isSessionInLocalProject(session: SessionMeta, target: RemoveLocalProjectTarget): boolean {
  const project = session.project;
  return (
    session.machineId === target.machineId &&
    project?.kind === 'local' &&
    project.localProjectId === target.localProjectId
  );
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
  const currentUserId = useAtomValue(userAtom)?.id;
  const { allActiveSessions } = useVisibleSessionMetas();
  const { requestSessionCancel } = useSessionActions();

  const getRemoveLocalProjectImpact = useCallback(
    (target: RemoveLocalProjectTarget): RemoveLocalProjectImpact => ({
      runningSessionCount: allActiveSessions.filter(
        (session) =>
          isSessionInLocalProject(session, target) && isActiveSessionStatus(session.status)
      ).length,
    }),
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
              (sessionStore) => resolveActiveAssistantTurnId(sessionStore.getState().history)
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
    async (target: RemoveLocalProjectTarget): Promise<boolean> => {
      if (!runtime) return false;

      try {
        const requestedAt = getServerNow();
        await runtime.writer.flockRowPut(
          getMachineFlockDocId(runtime.workspaceId, target.machineId),
          machineFlockKeys.deleteLocalProjectCommand(target.localProjectId),
          buildMachineDeleteLocalProjectCommand({
            requestedAt,
            requestedBy: currentUserId,
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

  return {
    removeLocalProject,
    getRemoveLocalProjectImpact,
  };
}
