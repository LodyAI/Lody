import type { SessionMeta, SessionProjectRun } from '@lody/shared';

/** Project group compatibility fields are published with the same run snapshot. */
export function projectRunMetaPatch(run: SessionProjectRun): Partial<SessionMeta> {
  const members = Object.values(run.members).sort((a, b) => a.o - b.o);
  const gitMembers = members.filter(
    (member) => member.access !== 'additional' && member.access !== 'link'
  );
  const first = members[0];
  if (!first) throw new Error('A project group must have members');
  const patch: Partial<SessionMeta> = {
    projectRun: run,
    project:
      first.src.kind === 'github'
        ? { kind: 'github', repoFullName: first.src.repoFullName, branch: first.base }
        : {
            kind: 'local',
            localProjectId: first.src.localProjectId,
            ...(first.access === 'additional' || first.access === 'link'
              ? {}
              : { branch: first.base }),
            useWorktree: first.access !== 'additional' && first.access !== 'link',
            ...(first.repoFullName ? { githubRepoFullName: first.repoFullName } : {}),
          },
    isWorktree: first.access !== 'additional' && first.access !== 'link',
  };
  if (first.branch) patch.branchName = first.branch;
  if (first.src.kind === 'github') patch.repoFullName = first.src.repoFullName;
  else if (first.repoFullName) patch.repoFullName = first.repoFullName;
  // Unknown observations must not turn the compatibility flags into false.
  for (const [field, target] of [
    ['dirty', 'workspaceDirty'],
    ['unpushed', 'workspaceUnpushed'],
  ] as const) {
    if (gitMembers.some((member) => member[field] === true)) patch[target] = true;
    else if (gitMembers.every((member) => member[field] === false)) patch[target] = false;
  }
  if (members.every((member) => member.diff !== undefined)) {
    patch.diffStats = {
      allChange: members.reduce(
        (sum, member) => ({ add: sum.add + member.diff!.add, del: sum.del + member.diff!.del }),
        { add: 0, del: 0 }
      ),
    };
  }
  return patch;
}
