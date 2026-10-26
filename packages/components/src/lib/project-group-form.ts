import {
  deduplicateProjectMembers,
  type MachineId,
  type LocalProjectId,
  type ProjectLocalMemberProbe,
  isSafeProjectPath,
  normalizeWorkspaceProject,
  resolveProjectMemberPaths,
  type ProjectId,
  type ProjectMember,
  type ProjectMemberId,
  type ProjectMemberPlacement,
  type ProjectMemberSource,
  type WorkspaceProject,
} from '@lody/shared';

/**
 * Project group editor state.
 *
 * A Project group is the UI name for a multi-repository `WorkspaceProject`;
 * "project" in the UI still means one local folder or one GitHub repository.
 *
 * The rules that must agree with the daemon — which paths are safe, which
 * placements overlap, which members are the same repository — are the shared
 * contract's. This module only adds what an editor needs on top: default
 * directory names, per-member error codes, and how submodule detection is
 * applied without overriding a choice the user made.
 */

export type ProjectGroupMemberDraft = {
  directory?: {
    machineId: MachineId;
    localProjectId: LocalProjectId;
    name: string;
    rootPath: string;
    inspection: ProjectLocalMemberProbe;
  };
  id: ProjectMemberId;
  source: ProjectMemberSource;
  placement: ProjectMemberPlacement;
  /**
   * Where the current placement came from. Detection may replace a `detected`
   * or `default` placement; it never replaces one the user set by hand.
   */
  placementOrigin: 'default' | 'detected' | 'user';
};

export type ProjectGroupFormValue = {
  name: string;
  instructions: string;
  members: ProjectGroupMemberDraft[];
};

export const EMPTY_PROJECT_GROUP_FORM_VALUE: ProjectGroupFormValue = {
  name: '',
  instructions: '',
  members: [],
};

export type ProjectGroupFormError = 'name_required' | 'members_required';

export type ProjectGroupMemberError =
  | 'dir_invalid'
  | 'dir_duplicate'
  | 'submodule_path_invalid'
  | 'submodule_parent_missing'
  | 'path_overlap'
  | 'duplicate_repository'
  | 'machine_mismatch';

export type ProjectGroupFormValidation = {
  errors: ProjectGroupFormError[];
  memberErrors: ReadonlyMap<ProjectMemberId, ProjectGroupMemberError>;
  valid: boolean;
};

/** The repository a local member points at, when its machine has reported one. */
export type ResolveLocalMemberRepository = (
  source: Extract<ProjectMemberSource, { kind: 'local' }>
) => { repoFullName: string; repoId?: number } | undefined;

/**
 * The machine a group's machine-bound members (folders without a GitHub
 * remote) live on. A conversation runs on one machine, so they must all share
 * it; repository members run wherever there is a copy or a clone. The first
 * machine-bound member decides.
 */
export function getProjectGroupLocalMachineId(
  value: Pick<ProjectGroupFormValue, 'members'>
): MachineId | null {
  for (const member of value.members) {
    if (member.source.kind === 'local') return member.source.machineId;
  }
  return null;
}

export const createProjectMemberId = (): ProjectMemberId =>
  crypto.randomUUID().replace(/-/g, '').slice(0, 12) as ProjectMemberId;

/** Stable identity of a source, for "already added" checks in pickers. */
export function getProjectMemberSourceKey(source: ProjectMemberSource): string {
  return source.kind === 'github'
    ? `github:${source.repoFullName.toLowerCase()}`
    : `local:${source.machineId}:${source.localProjectId}`;
}

/**
 * A directory name derived from a display name: the last path segment of a
 * repository name, reduced to characters every platform accepts.
 */
export function suggestProjectMemberDir(label: string): string {
  const last = label.split('/').filter(Boolean).pop() ?? '';
  const cleaned = Array.from(last, (char) => (char.charCodeAt(0) < 32 ? '-' : char))
    .join('')
    .replace(/[\\<>:"|?*]/g, '-')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned && isSafeProjectPath(cleaned) ? cleaned : 'repo';
}

function uniqueDir(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Append a source as a top-level member with a unique default directory. */
export function addProjectGroupMember(
  value: ProjectGroupFormValue,
  source: ProjectMemberSource,
  label: string,
  createId: () => ProjectMemberId = createProjectMemberId
): ProjectGroupFormValue {
  const key = getProjectMemberSourceKey(source);
  if (value.members.some((member) => getProjectMemberSourceKey(member.source) === key)) {
    return value;
  }
  const taken = new Set(
    value.members.flatMap((member) =>
      member.placement.kind === 'root' ? [member.placement.dir.toLowerCase()] : []
    )
  );
  const member: ProjectGroupMemberDraft = {
    id: createId(),
    source,
    placement: { kind: 'root', dir: uniqueDir(suggestProjectMemberDir(label), taken) },
    placementOrigin: 'default',
  };
  return { ...value, members: [...value.members, member] };
}

/** Attach a prepared folder to the draft only; paths never enter Project sources. */
export function addProjectGroupDirectory(
  value: ProjectGroupFormValue,
  directory: NonNullable<ProjectGroupMemberDraft['directory']>
): ProjectGroupFormValue {
  const source: ProjectMemberSource = directory.inspection.repoFullName
    ? { kind: 'github', repoFullName: directory.inspection.repoFullName, preferLocal: true }
    : { kind: 'local', machineId: directory.machineId, localProjectId: directory.localProjectId };
  const next = addProjectGroupMember(value, source, directory.name);
  if (next === value) {
    const existing = value.members.find(
      (member) => getProjectMemberSourceKey(member.source) === getProjectMemberSourceKey(source)
    );
    if (!existing || existing.directory) return value;
    return {
      ...value,
      members: value.members.map((member) =>
        member === existing ? { ...member, directory } : member
      ),
    };
  }
  return {
    ...next,
    members: next.members.map((member, index) =>
      index === next.members.length - 1 ? { ...member, directory } : member
    ),
  };
}

/**
 * Remove a member. Its submodule children become top-level again rather than
 * disappearing: the user removed one repository, not its dependents.
 */
export function removeProjectGroupMember(
  value: ProjectGroupFormValue,
  memberId: ProjectMemberId,
  labelOf: (member: ProjectGroupMemberDraft) => string
): ProjectGroupFormValue {
  const remaining = value.members.filter((member) => member.id !== memberId);
  const taken = new Set(
    remaining.flatMap((member) =>
      member.placement.kind === 'root' ? [member.placement.dir.toLowerCase()] : []
    )
  );
  const members = remaining.map((member) => {
    if (member.placement.kind !== 'submodule' || member.placement.parent !== memberId) {
      return member;
    }
    const dir = uniqueDir(suggestProjectMemberDir(labelOf(member)), taken);
    taken.add(dir.toLowerCase());
    return {
      ...member,
      placement: { kind: 'root', dir } as const,
      placementOrigin: 'default' as const,
    };
  });
  return { ...value, members };
}

/**
 * Where a new project's conversations run, chosen before any member: on one
 * machine, which may then contribute its folders, or anywhere, which admits
 * only GitHub repositories.
 */
export type ProjectGroupScope = { kind: 'machine'; machineId: MachineId } | { kind: 'github' };

/**
 * Drops the members a scope cannot hold: folders bound to another machine, and
 * for a GitHub-only project every folder, including a picked folder that only
 * a GitHub remote made portable. Repository members stay. Returns the same
 * value when nothing goes.
 */
export function retainProjectGroupScope(
  value: ProjectGroupFormValue,
  scope: ProjectGroupScope,
  labelOf: (member: ProjectGroupMemberDraft) => string
): ProjectGroupFormValue {
  const outside = (member: ProjectGroupMemberDraft) => {
    const machineId =
      member.directory?.machineId ??
      (member.source.kind === 'local' ? member.source.machineId : undefined);
    if (machineId === undefined) return false;
    return scope.kind === 'github' || machineId !== scope.machineId;
  };
  let result = value;
  for (const member of value.members) {
    if (outside(member)) result = removeProjectGroupMember(result, member.id, labelOf);
  }
  if (scope.kind !== 'github') return result;
  // GitHub only means a clone per conversation, never a machine's copy.
  const members = result.members.map((member) =>
    member.source.kind === 'github' && member.source.preferLocal
      ? { ...member, source: withoutLocalCopy(member.source) }
      : member
  );
  return members.some((member, index) => member !== result.members[index])
    ? { ...result, members }
    : result;
}

/** The same repository, cloned for each conversation instead of using a machine's copy. */
export function withoutLocalCopy(
  source: Extract<ProjectMemberSource, { kind: 'github' }>
): Extract<ProjectMemberSource, { kind: 'github' }> {
  const { preferLocal: _preferLocal, ...rest } = source;
  return rest;
}

/** Replace one member's source, keeping its id and placement; a picked folder can be dropped. */
export function setProjectGroupMemberSource(
  value: ProjectGroupFormValue,
  memberId: ProjectMemberId,
  source: ProjectMemberSource,
  options: { dropDirectory?: boolean } = {}
): ProjectGroupFormValue {
  return {
    ...value,
    members: value.members.map((member) => {
      if (member.id !== memberId) return member;
      if (!options.dropDirectory) return { ...member, source };
      const { directory: _directory, ...rest } = member;
      return { ...rest, source };
    }),
  };
}

/** A name for a new project from its first member, unless one was typed. */
export function suggestProjectGroupName(
  value: ProjectGroupFormValue,
  labelOf: (member: ProjectGroupMemberDraft) => string
): string {
  if (value.name.trim()) return value.name;
  const first = value.members[0];
  if (!first) return value.name;
  return labelOf(first).split('/').filter(Boolean).pop() ?? value.name;
}

/**
 * Apply a multi-select change: sources newly ticked are added, sources
 * unticked are removed (their submodules become top-level). Members whose
 * project is no longer listed are not in the picker, so they are untouched.
 */
export function applySourceSelection(
  value: ProjectGroupFormValue,
  previous: readonly { key: string }[],
  next: readonly { key: string; source: ProjectMemberSource; label: string }[],
  labelOf: (member: ProjectGroupMemberDraft) => string,
  createId: () => ProjectMemberId = createProjectMemberId
): ProjectGroupFormValue {
  const nextKeys = new Set(next.map((option) => option.key));
  const previousKeys = new Set(previous.map((option) => option.key));
  let result = value;
  for (const option of previous) {
    if (nextKeys.has(option.key)) continue;
    const member = result.members.find(
      (candidate) => getProjectMemberSourceKey(candidate.source) === option.key
    );
    if (member) result = removeProjectGroupMember(result, member.id, labelOf);
  }
  for (const option of next) {
    if (!previousKeys.has(option.key)) {
      result = addProjectGroupMember(result, option.source, option.label, createId);
    }
  }
  return result;
}

export function updateProjectGroupMemberPlacement(
  value: ProjectGroupFormValue,
  memberId: ProjectMemberId,
  placement: ProjectMemberPlacement
): ProjectGroupFormValue {
  return {
    ...value,
    members: value.members.map((member) =>
      member.id === memberId ? { ...member, placement, placementOrigin: 'user' } : member
    ),
  };
}

/** One submodule a member's repository declares, with the repository it points at. */
export type DetectedProjectSubmodule = { path: string; repoFullName?: string };

/**
 * Apply detected submodule relationships.
 *
 * A member becomes a submodule of `parent` when one of the parent's declared
 * submodules points at the member's repository. Only `default` and `detected`
 * placements move; a placement the user chose stays. A detected relationship
 * that is no longer declared reverts to a top-level member.
 */
export function applyDetectedProjectSubmodules(
  value: ProjectGroupFormValue,
  detected: ReadonlyMap<ProjectMemberId, readonly DetectedProjectSubmodule[]>,
  repositoryOf: (member: ProjectGroupMemberDraft) => string | undefined,
  labelOf: (member: ProjectGroupMemberDraft) => string
): ProjectGroupFormValue {
  const byRepository = new Map<string, ProjectMemberId>();
  for (const member of value.members) {
    const repo = repositoryOf(member)?.toLowerCase();
    if (repo && !byRepository.has(repo)) byRepository.set(repo, member.id);
  }
  const next = new Map<ProjectMemberId, Extract<ProjectMemberPlacement, { kind: 'submodule' }>>();
  for (const [parentId, submodules] of detected) {
    for (const submodule of submodules) {
      const childId = submodule.repoFullName
        ? byRepository.get(submodule.repoFullName.toLowerCase())
        : undefined;
      if (!childId || childId === parentId || next.has(childId)) continue;
      if (!isSafeProjectPath(submodule.path)) continue;
      next.set(childId, { kind: 'submodule', parent: parentId, path: submodule.path });
    }
  }

  const taken = new Set(
    value.members.flatMap((member) =>
      member.placement.kind === 'root' ? [member.placement.dir.toLowerCase()] : []
    )
  );
  let changed = false;
  const members = value.members.map((member) => {
    if (member.placementOrigin === 'user') return member;
    const placement = next.get(member.id);
    if (placement) {
      if (
        member.placement.kind === 'submodule' &&
        member.placement.parent === placement.parent &&
        member.placement.path === placement.path
      ) {
        return member;
      }
      changed = true;
      return { ...member, placement, placementOrigin: 'detected' as const };
    }
    if (member.placementOrigin === 'detected' && member.placement.kind === 'submodule') {
      changed = true;
      const dir = uniqueDir(suggestProjectMemberDir(labelOf(member)), taken);
      taken.add(dir.toLowerCase());
      return {
        ...member,
        placement: { kind: 'root', dir } as const,
        placementOrigin: 'default' as const,
      };
    }
    return member;
  });
  if (!changed) return value;

  // Detection must never produce a forest the contract rejects (for example a
  // cycle between two repositories that each vendor the other); keep the
  // previous state instead of handing the user an unsavable form.
  try {
    resolveProjectMemberPaths(members.map(toProjectMember));
  } catch {
    return value;
  }
  return { ...value, members };
}

const toProjectMember = (member: ProjectGroupMemberDraft): ProjectMember => ({
  id: member.id,
  source: member.source,
  placement: member.placement,
});

export function validateProjectGroupForm(
  value: ProjectGroupFormValue,
  resolveLocal?: ResolveLocalMemberRepository
): ProjectGroupFormValidation {
  const errors: ProjectGroupFormError[] = [];
  if (!value.name.trim()) errors.push('name_required');
  if (value.members.length === 0) errors.push('members_required');

  const memberErrors = new Map<ProjectMemberId, ProjectGroupMemberError>();
  const ids = new Set(value.members.map((member) => member.id));
  const rootDirs = new Map<string, ProjectMemberId>();
  for (const member of value.members) {
    const placement = member.placement;
    if (placement.kind === 'root') {
      if (!isSafeProjectPath(placement.dir) || placement.dir.includes('/')) {
        memberErrors.set(member.id, 'dir_invalid');
        continue;
      }
      const key = placement.dir.toLowerCase();
      const first = rootDirs.get(key);
      if (first) {
        memberErrors.set(member.id, 'dir_duplicate');
        if (!memberErrors.has(first)) memberErrors.set(first, 'dir_duplicate');
      } else rootDirs.set(key, member.id);
    } else {
      if (!isSafeProjectPath(placement.path)) memberErrors.set(member.id, 'submodule_path_invalid');
      else if (!ids.has(placement.parent) || placement.parent === member.id)
        memberErrors.set(member.id, 'submodule_parent_missing');
    }
  }

  const machineId = getProjectGroupLocalMachineId(value);
  for (const member of value.members) {
    if (
      member.source.kind === 'local' &&
      member.source.machineId !== machineId &&
      !memberErrors.has(member.id)
    ) {
      memberErrors.set(member.id, 'machine_mismatch');
    }
  }

  const members = value.members.map(toProjectMember);
  const kept = new Set(deduplicateProjectMembers(members, resolveLocal).map((member) => member.id));
  for (const member of value.members) {
    if (!kept.has(member.id) && !memberErrors.has(member.id))
      memberErrors.set(member.id, 'duplicate_repository');
  }

  if (memberErrors.size === 0 && members.length > 0) {
    try {
      resolveProjectMemberPaths(members);
    } catch {
      // The contract reports overlap or a parent cycle for the forest as a
      // whole; mark the submodule members, which are the ones a user can fix.
      for (const member of value.members) {
        if (member.placement.kind === 'submodule') memberErrors.set(member.id, 'path_overlap');
      }
      if (memberErrors.size === 0) {
        for (const member of value.members) memberErrors.set(member.id, 'path_overlap');
      }
    }
  }

  return { errors, memberErrors, valid: errors.length === 0 && memberErrors.size === 0 };
}

export function buildProjectGroupFormValue(project: WorkspaceProject): ProjectGroupFormValue {
  return {
    name: project.name,
    instructions: project.instructions ?? '',
    members: project.members.map((member) => ({
      ...member,
      // A saved placement is the user's decision, whoever proposed it first.
      placementOrigin: 'user',
    })),
  };
}

/**
 * Turns local members whose machine now publishes a GitHub remote into
 * repository Members, keeping each member's id, directory, submodule
 * placement and base branch, so a group saved before repository Members runs
 * on any machine once it is saved again. A member whose repository is already
 * in the group stays as it is; validation reports the duplicate. Returns the
 * same value when nothing changes.
 */
export function upgradeProjectGroupRepositoryMembers(
  value: ProjectGroupFormValue,
  remoteOf: (source: Extract<ProjectMemberSource, { kind: 'local' }>) => string | undefined
): ProjectGroupFormValue {
  const taken = new Set(
    value.members.flatMap((member) =>
      member.source.kind === 'github' ? [member.source.repoFullName.toLowerCase()] : []
    )
  );
  let changed = false;
  const members = value.members.map((member) => {
    if (member.source.kind !== 'local') return member;
    const repoFullName = remoteOf(member.source);
    if (!repoFullName || taken.has(repoFullName.toLowerCase())) return member;
    taken.add(repoFullName.toLowerCase());
    changed = true;
    const source: ProjectMemberSource = {
      kind: 'github',
      repoFullName,
      preferLocal: true,
      ...(member.source.baseBranch ? { baseBranch: member.source.baseBranch } : {}),
    };
    return { ...member, source };
  });
  return changed ? { ...value, members } : value;
}

const sameContent = (left: WorkspaceProject, right: WorkspaceProject): boolean =>
  left.name === right.name &&
  (left.instructions ?? '') === (right.instructions ?? '') &&
  JSON.stringify(left.members) === JSON.stringify(right.members);

/**
 * The row to write. `revision` moves only when the content does, so opening
 * and saving an unchanged group writes nothing new for anyone reading it.
 * Returns `undefined` when the contract rejects the result.
 */
export function buildWorkspaceProjectFromForm(
  value: ProjectGroupFormValue,
  options: {
    id: ProjectId;
    existing?: WorkspaceProject;
    ownerUserId: string;
    now: number;
  }
): WorkspaceProject | undefined {
  const instructions = value.instructions.trim();
  const draft: WorkspaceProject = {
    v: 1,
    id: options.id,
    name: value.name.trim(),
    ...(instructions ? { instructions } : {}),
    ownerUserId: options.existing?.ownerUserId ?? options.ownerUserId,
    createdAtMs: options.existing?.createdAtMs ?? options.now,
    revision: options.existing?.revision ?? 1,
    members: value.members.map(toProjectMember),
  };
  if (options.existing) {
    if (sameContent(options.existing, draft)) return options.existing;
    draft.revision = options.existing.revision + 1;
  }
  return normalizeWorkspaceProject(draft);
}

/** Members that are submodules of `parentId`, directly or through another submodule. */
export function collectProjectSubmoduleDescendants(
  members: readonly Pick<ProjectMember, 'id' | 'placement'>[],
  parentId: ProjectMemberId
): Set<ProjectMemberId> {
  const descendants = new Set<ProjectMemberId>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const member of members) {
      if (member.placement.kind !== 'submodule' || descendants.has(member.id)) continue;
      if (member.placement.parent === parentId || descendants.has(member.placement.parent)) {
        descendants.add(member.id);
        grew = true;
      }
    }
  }
  return descendants;
}
