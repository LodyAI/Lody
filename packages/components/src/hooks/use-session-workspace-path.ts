import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { getMachineFlockLocalProjects, type SessionMeta } from '@lody/shared';
import { getMachineMetaByIdAtomFamily } from '@/atoms';
import { useMachineFlockRows } from './use-machine-flock-rows';
import {
  resolveSessionLocalProjectRootPath,
  resolveSessionRepoFullName,
} from '@/lib/session-local-file-source';
import {
  resolveMachineDotlodyPath,
  resolveSessionWorkspacePath,
} from '@/lib/session-workspace-path';

/** Cached path context only; the desktop verifies target identity before reading. */
export function useSessionWorkspacePath(
  session: SessionMeta | null | undefined,
  homeDir?: string | null
) {
  const machine = useAtomValue(getMachineMetaByIdAtomFamily(session?.machineId ?? undefined));
  const rows = useMachineFlockRows(session?.machineId ?? null, {
    families: ['localProject', 'dotlodyPath'],
  });
  return useMemo(() => {
    if (!session) return null;
    const projectRoot = resolveSessionLocalProjectRootPath(session, {
      ...(machine?.localProjects ?? {}),
      ...getMachineFlockLocalProjects(rows),
    });
    // Missing project metadata must not turn a relative path into a chat path.
    if (session.project?.kind === 'local' && !projectRoot) return null;
    if (session.project && !projectRoot && session.isWorktree !== true) {
      return machine?.workspacePaths?.[session.id] ?? null;
    }
    return resolveSessionWorkspacePath({
      sessionId: session.id,
      ownerSessionId: session.parentSessionId,
      isWorktree: session.isWorktree,
      dotlodyPath: resolveMachineDotlodyPath(rows, homeDir),
      localProjectRootPath: projectRoot,
      repoFullName: resolveSessionRepoFullName(session),
      legacyWorkspacePath: machine?.workspacePaths?.[session.id],
    });
  }, [session, machine, rows, homeDir]);
}
