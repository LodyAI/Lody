import {
  getProjectBoundMachineId,
  type MachineId,
  type ProjectMember,
  type ProjectMemberId,
  type ProjectRef,
  type WorkspaceProject,
} from '@lody/shared';

export type ProjectGroupLaunchTarget =
  | { kind: 'ready'; members: ProjectMember[]; machineId: MachineId | null }
  | { kind: 'machines_conflict'; machineIds: MachineId[] };

/**
 * Where a conversation in this group runs, with every member: a conversation
 * is created from the group as configured, never a subset of it. Local
 * members pin the machine that holds them; repository members run anywhere.
 * Local members on two machines cannot share one conversation, because a
 * conversation runs on one machine.
 */
export function resolveProjectGroupLaunchTarget(
  project: Pick<WorkspaceProject, 'members'>
): ProjectGroupLaunchTarget {
  const machineIds = [
    ...new Set(
      project.members.flatMap((member) =>
        member.source.kind === 'local' ? [member.source.machineId] : []
      )
    ),
  ];
  if (machineIds.length > 1) return { kind: 'machines_conflict', machineIds };
  return { kind: 'ready', members: [...project.members], machineId: machineIds[0] ?? null };
}

/**
 * The legacy `project` field: the first member, so older clients still show
 * a repository, a branch and a PR for the conversation. `HEAD` is the same
 * placeholder the snapshot uses; the daemon resolves it to the base branch.
 */
export function buildProjectGroupProjectRef(member: ProjectMember): ProjectRef {
  return member.source.kind === 'github'
    ? {
        kind: 'github',
        repoFullName: member.source.repoFullName,
        branch: member.source.baseBranch ?? 'HEAD',
      }
    : {
        kind: 'local',
        localProjectId: member.source.localProjectId,
        ...(member.source.baseBranch ? { branch: member.source.baseBranch } : {}),
        useWorktree: true,
      };
}

/** Machines holding a copy of each repository, from what machines publish. */
export type ProjectRepositoryCopyIndex = ReadonlyMap<string, ReadonlySet<MachineId>>;

export function buildProjectRepositoryCopyIndex(
  localProjects: Iterable<{ machineId: MachineId; project: { githubRepoFullName?: string } }>
): ProjectRepositoryCopyIndex {
  const index = new Map<string, Set<MachineId>>();
  for (const entry of localProjects) {
    const repo = entry.project.githubRepoFullName?.toLowerCase();
    if (!repo) continue;
    const machines = index.get(repo) ?? new Set<MachineId>();
    machines.add(entry.machineId);
    index.set(repo, machines);
  }
  return index;
}

/**
 * What a group can do on one machine.
 * - `elsewhere`: its folders without a remote are on another machine; the
 *   composer does not list it there, as for a single local project.
 * - `conflict`: those folders are on several machines (saved before the
 *   editor forbade it); listed, never startable.
 * - `available`: `missing` are the repository Members this machine has no
 *   copy of. A managed deployment clones them; local-only mode cannot, so
 *   the group cannot start on this machine.
 */
export type ProjectGroupMachineAvailability =
  | { kind: 'elsewhere'; machineId: MachineId }
  | { kind: 'conflict' }
  | { kind: 'available'; missing: ReadonlySet<ProjectMemberId> };

export function getProjectGroupMachineAvailability(
  project: Pick<WorkspaceProject, 'members'>,
  machineId: MachineId | null,
  copies: ProjectRepositoryCopyIndex
): ProjectGroupMachineAvailability {
  const bound = getProjectBoundMachineId(project.members);
  if (bound === 'conflict') return { kind: 'conflict' };
  if (bound && machineId && bound !== machineId) return { kind: 'elsewhere', machineId: bound };
  const missing = new Set<ProjectMemberId>();
  if (machineId) {
    for (const member of project.members) {
      const source = member.source;
      if (source.kind !== 'github' || !source.preferLocal) continue;
      if (!copies.get(source.repoFullName.toLowerCase())?.has(machineId)) missing.add(member.id);
    }
  }
  return { kind: 'available', missing };
}
