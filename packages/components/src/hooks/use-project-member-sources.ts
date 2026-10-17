import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import type { MachineId, ProjectMemberSource } from '@lody/shared';
import { workspaceReposCacheAtomFamily } from '@/atoms/local-storage-cache';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { useAppCapability } from '@/lib/app-platform';
import { getProjectMemberSourceKey } from '@/lib/project-group-form';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { usePendingLocalProjectRemovals } from '@/hooks/use-remove-local-project';
import { useVisibleLocalProjects } from '@/hooks/use-visible-local-projects';

/** One project that can join a Project group, with how the editor names it. */
export type ProjectMemberSourceOption = {
  key: string;
  source: ProjectMemberSource;
  /** Local project name, or `owner/repo`. */
  label: string;
  /** The machine for a local project; the repository description for GitHub. */
  detail?: string;
  /** Local projects only: whether the owning machine is online. */
  online?: boolean;
};

export type ProjectMemberSources = {
  options: ProjectMemberSourceOption[];
  /** Looks up any source, including one whose project is no longer listed. */
  byKey: ReadonlyMap<string, ProjectMemberSourceOption>;
};

/**
 * Everything a Project group may contain: the visible local projects, then
 * the workspace's GitHub repositories when GitHub integration exists.
 *
 * GitHub rows paint from the repository cache, the same source the chat
 * landing uses; local projects awaiting removal are not offered.
 */
export function useProjectMemberSources(): ProjectMemberSources {
  const { workspaceId } = useResolvedWorkspaceScope();
  const githubAvailable = useAppCapability('githubIntegration');
  const cachedRepositories = useAtomValue(workspaceReposCacheAtomFamily(workspaceId));
  const onlineMachineIds = useAtomValue(onlineMachineIdsAtom);
  const { projects } = useVisibleLocalProjects();
  const machineIds = useMemo(
    () => [...new Set([...projects.values()].map((entry) => entry.machineId))],
    [projects]
  );
  const pendingRemovals = usePendingLocalProjectRemovals(machineIds);

  return useMemo(() => {
    const local: ProjectMemberSourceOption[] = [];
    for (const entry of projects.values()) {
      if (pendingRemovals.has(entry.key)) continue;
      const source: ProjectMemberSource = {
        kind: 'local',
        machineId: entry.machineId as MachineId,
        localProjectId: entry.project.id,
      };
      local.push({
        key: getProjectMemberSourceKey(source),
        source,
        label: entry.project.name,
        detail: entry.machine.name || entry.machineId,
        online: onlineMachineIds.has(entry.machineId),
      });
    }
    local.sort((left, right) => left.label.localeCompare(right.label));

    const github: ProjectMemberSourceOption[] = githubAvailable
      ? (cachedRepositories ?? []).map((repo) => {
          const source: ProjectMemberSource = { kind: 'github', repoFullName: repo.fullName };
          return {
            key: getProjectMemberSourceKey(source),
            source,
            label: repo.fullName,
            detail: repo.description ?? undefined,
          };
        })
      : [];

    const options = [...local, ...github];
    return { options, byKey: new Map(options.map((option) => [option.key, option])) };
  }, [cachedRepositories, githubAvailable, onlineMachineIds, pendingRemovals, projects]);
}
