import { isCoordinatorSession, type SessionMeta } from '@lody/shared';
import { useRouter } from '@tanstack/react-router';
import { useAtomValue } from 'jotai';
import { useCallback } from 'react';
import { developerModeEnabledAtom } from '@/atoms/settings';
import { currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { getSessionCoordinatorProjectKey } from './project-board-model';

/**
 * "Change coordinator" for a project's coordinator conversation (Developer
 * mode): opens the start-coordinator page for the same project. The project
 * stays bound to this conversation until a new coordinator is created there.
 * `undefined` when the conversation is not a coordinator or has no project.
 */
export function useChangeCoordinatorAction(
  session: Pick<SessionMeta, 'coordinator' | 'project' | 'machineId' | 'repoFullName'>
): (() => void) | undefined {
  const developerMode = useAtomValue(developerModeEnabledAtom);
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const router = useRouter();
  const key =
    developerMode && isCoordinatorSession(session)
      ? getSessionCoordinatorProjectKey(session)
      : null;
  const machineId = key?.kind === 'local' ? key.machineId : null;
  const localProjectId = key?.kind === 'local' ? key.localProjectId : null;
  const repoFullName = key?.kind === 'github' ? key.repoFullName : null;
  const changeCoordinator = useCallback(() => {
    if (!workspaceSlug) return;
    void router.navigate({
      to: '/$workspaceName/chat',
      params: { workspaceName: workspaceSlug },
      search:
        machineId && localProjectId
          ? { context: 'local', machine: machineId, project: localProjectId, coordinator: true }
          : { context: 'github', repo: repoFullName ?? '', coordinator: true },
    });
  }, [localProjectId, machineId, repoFullName, router, workspaceSlug]);
  return key ? changeCoordinator : undefined;
}
