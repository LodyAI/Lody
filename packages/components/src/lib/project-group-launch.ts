import {
  selectProjectMembers,
  type MachineId,
  type ProjectMember,
  type ProjectMemberId,
  type ProjectRef,
  type WorkspaceProject,
} from '@lody/shared';

/**
 * The members a new conversation will use: everything not unticked, minus the
 * submodules of an unticked parent — a submodule is checked out by its
 * parent's worktree, so it cannot exist without it. The rule is the shared
 * contract's `selectProjectMembers`; the picker speaks in exclusions.
 */
export function selectProjectGroupMembers(
  project: Pick<WorkspaceProject, 'members'>,
  excluded: ReadonlySet<ProjectMemberId>
): ProjectMember[] {
  return selectProjectMembers(
    project.members,
    project.members.filter((member) => !excluded.has(member.id)).map((member) => member.id)
  );
}

export type ProjectGroupLaunchTarget =
  | { kind: 'ready'; members: ProjectMember[]; machineId: MachineId | null }
  | { kind: 'empty' }
  | { kind: 'machines_conflict'; machineIds: MachineId[] };

/**
 * Where a conversation in this group can run. Local members pin the machine
 * that holds them; GitHub members run anywhere. Local members on two machines
 * cannot share one conversation, because a conversation runs on one machine.
 */
export function resolveProjectGroupLaunchTarget(
  project: Pick<WorkspaceProject, 'members'>,
  excluded: ReadonlySet<ProjectMemberId>
): ProjectGroupLaunchTarget {
  const members = selectProjectGroupMembers(project, excluded);
  if (members.length === 0) return { kind: 'empty' };
  const machineIds = [
    ...new Set(
      members.flatMap((member) => (member.source.kind === 'local' ? [member.source.machineId] : []))
    ),
  ];
  if (machineIds.length > 1) return { kind: 'machines_conflict', machineIds };
  return { kind: 'ready', members, machineId: machineIds[0] ?? null };
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
