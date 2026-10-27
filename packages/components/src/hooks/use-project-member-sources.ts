import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import type { MachineId } from '@lody/shared';
import { workspaceReposCacheAtomFamily } from '@/atoms/local-storage-cache';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { useAppCapability } from '@/lib/app-platform';
import {
  buildProjectMemberSourceOptions,
  type ProjectMemberSourceOption,
} from '@/lib/project-member-sources';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { usePendingLocalProjectRemovals } from '@/hooks/use-remove-local-project';
import { useVisibleLocalProjects } from '@/hooks/use-visible-local-projects';

export type { ProjectMemberSourceOption } from '@/lib/project-member-sources';

export type ProjectMemberSources = {
  options: ProjectMemberSourceOption[];
  /** Looks up any source, including one whose project is no longer listed. */
  byKey: ReadonlyMap<string, ProjectMemberSourceOption>;
};

/**
 * Everything a Project group may contain, one row per repository: the
 * visible local projects merged by the GitHub remote their machine publishes,
 * the workspace's GitHub repositories when GitHub integration exists, and the
 * folders without a remote.
 *
 * GitHub rows paint from the repository cache, the same source the chat
 * landing uses; local projects awaiting removal are not offered.
 */
export function useProjectMemberSources(): ProjectMemberSources {
  const { workspaceId } = useResolvedWorkspaceScope();
  const githubAvailable = useAppCapability('githubIntegration');
  const cachedRepositories = useAtomValue(workspaceReposCacheAtomFamily(workspaceId));
  const onlineMachineIds = useAtomValue(onlineMachineIdsAtom);
  const { projects } = useVisibleLocalProjects({ includeMemberOnly: true });
  const machineIds = useMemo(
    () => [...new Set([...projects.values()].map((entry) => entry.machineId))],
    [projects]
  );
  const pendingRemovals = usePendingLocalProjectRemovals(machineIds);

  return useMemo(() => {
    const options = buildProjectMemberSourceOptions({
      localProjects: [...projects.values()]
        .filter((entry) => !pendingRemovals.has(entry.key))
        .map((entry) => ({
          machineId: entry.machineId as MachineId,
          machineName: entry.machine.name || entry.machineId,
          online: onlineMachineIds.has(entry.machineId),
          project: entry.project,
        })),
      githubRepositories: githubAvailable ? (cachedRepositories ?? []) : [],
    });
    const byKey = new Map(options.map((option) => [option.key, option]));
    // A group saved before repository Members names a copy by its machine;
    // that key still finds the repository the copy now belongs to.
    for (const option of options) {
      for (const key of option.localKeys) if (!byKey.has(key)) byKey.set(key, option);
    }
    return { options, byKey };
  }, [cachedRepositories, githubAvailable, onlineMachineIds, pendingRemovals, projects]);
}
