import { z } from 'zod/v4';

// Multi-repository projects ("Project groups"), ported from web @lody/shared
// `workspace-project.ts` and components `project-group-launch.ts`. A group is a
// workspace row `['project', <uuid>]` in `${workspaceId}:wf:workspace`; a session
// started in it carries a frozen `projectRun` snapshot that the machine prepares.

export type ProjectMemberSource =
  | {
      kind: 'github';
      repoFullName: string;
      repoId?: number;
      baseBranch?: string;
      preferLocal?: true;
    }
  | {
      kind: 'local';
      machineId: string;
      localProjectId: string;
      baseBranch?: string;
    };
export type ProjectMemberPlacement =
  | { kind: 'root'; dir: string }
  | { kind: 'submodule'; parent: string; path: string };
export type ProjectMember = {
  id: string;
  source: ProjectMemberSource;
  placement: ProjectMemberPlacement;
};
export type WorkspaceProject = {
  v: 1;
  id: string;
  name: string;
  instructions?: string;
  ownerUserId: string;
  createdAtMs: number;
  revision: number;
  members: ProjectMember[];
};
export type SessionProjectRun = {
  id: string;
  name: string;
  instructions?: string;
  root: string;
  members: Record<
    string,
    {
      o: number;
      src: ProjectMemberSource;
      placement: ProjectMemberPlacement;
      path: string;
      base: string;
    }
  >;
};

// Portable Git paths: reject Windows aliases as well as POSIX traversal.
export function isSafeProjectPath(value: string): boolean {
  return (
    value.length > 0 &&
    value
      .split('/')
      .every(
        (part) =>
          part.length > 0 &&
          part !== '.' &&
          part !== '..' &&
          !Array.from(part).some((char) => char.charCodeAt(0) < 32) &&
          !/[\\<>:"|?*]/.test(part) &&
          !/[. ]$/.test(part) &&
          !/^(?:\.git|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}
const pathSchema = z.string().refine(isSafeProjectPath);
const segmentSchema = pathSchema.refine((value) => !value.includes('/'));
const memberIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  .refine(
    (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  );
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('github'),
    repoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    repoId: z.number().int().positive().optional(),
    baseBranch: z.string().min(1).optional(),
    preferLocal: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal('local'),
    machineId: z.string().min(1),
    localProjectId: z.string().min(1),
    baseBranch: z.string().min(1).optional(),
  }),
]);
const placementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root'), dir: segmentSchema }),
  z.object({
    kind: z.literal('submodule'),
    parent: memberIdSchema,
    path: pathSchema,
  }),
]);
const memberSchema = z.object({
  id: memberIdSchema,
  source: sourceSchema,
  placement: placementSchema,
});

/** The frozen placement forest; rejects missing parents, cycles and overlapping siblings. */
export function resolveProjectMemberPaths(
  members: readonly ProjectMember[],
): Record<string, string> {
  const byId = new Map(members.map((member) => [member.id, member]));
  if (byId.size !== members.length)
    throw new Error('Duplicate Project Member ID');
  const paths = Object.create(null) as Record<string, string>;
  const visiting = new Set<string>();
  const visit = (id: string): string => {
    if (paths[id]) return paths[id];
    const member = byId.get(id);
    if (!member || visiting.has(id))
      throw new Error('Invalid Project Member parent');
    visiting.add(id);
    const p = member.placement;
    const suffix = p.kind === 'root' ? p.dir : p.path;
    if (
      !isSafeProjectPath(suffix) ||
      (p.kind === 'root' && suffix.includes('/'))
    )
      throw new Error('Invalid Project Member path');
    const path = p.kind === 'root' ? suffix : `${visit(p.parent)}/${suffix}`;
    visiting.delete(id);
    paths[id] = path;
    return path;
  };
  for (const member of members) visit(member.id);
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i]!;
      const b = members[j]!;
      const ap = paths[a.id]!.toLowerCase();
      const bp = paths[b.id]!.toLowerCase();
      const ancestor = (parent: string, child: ProjectMember): boolean => {
        let p = child.placement;
        while (p.kind === 'submodule') {
          if (p.parent === parent) return true;
          p = byId.get(p.parent)!.placement;
        }
        return false;
      };
      if (
        ap === bp ||
        (ap.startsWith(`${bp}/`) && !ancestor(b.id, a)) ||
        (bp.startsWith(`${ap}/`) && !ancestor(a.id, b))
      )
        throw new Error('Overlapping Project Member paths');
    }
  return paths;
}

/** A repository appears once (web `deduplicateProjectMembers` without machine-local identities). */
function uniqueMembers(members: readonly ProjectMember[]): boolean {
  const seen = new Set<string>();
  for (const member of members) {
    const key =
      member.source.kind === 'github'
        ? member.source.repoId !== undefined
          ? `github-id:${member.source.repoId}`
          : `github:${member.source.repoFullName.toLowerCase()}`
        : JSON.stringify([
            'local',
            member.source.machineId,
            member.source.localProjectId,
          ]);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function validMembers(members: ProjectMember[]): boolean {
  try {
    resolveProjectMemberPaths(members);
    return uniqueMembers(members);
  } catch {
    return false;
  }
}

const workspaceProjectSchema = z.object({
  v: z.literal(1),
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  instructions: z.string().optional(),
  ownerUserId: z.string().min(1),
  createdAtMs: z.number().finite().nonnegative(),
  revision: z.number().int().positive(),
  members: z.array(memberSchema).min(1).refine(validMembers),
});

export function normalizeWorkspaceProject(
  value: unknown,
  key?: unknown,
): WorkspaceProject | undefined {
  const result = workspaceProjectSchema.safeParse(value);
  if (!result.success || (key !== undefined && result.data.id !== key))
    return undefined;
  return result.data as WorkspaceProject;
}

/** Every group in a workspace flock scan, by name then id (web `listWorkspaceProjects`). */
export function listWorkspaceProjects(
  rows: { key: unknown[]; value?: unknown }[],
): WorkspaceProject[] {
  const projects: WorkspaceProject[] = [];
  for (const row of rows) {
    if (row.key.length !== 2 || row.key[0] !== 'project') continue;
    const project = normalizeWorkspaceProject(row.value, row.key[1]);
    if (project) projects.push(project);
  }
  return projects.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

export function getProjectRunRoot(
  project: Pick<WorkspaceProject, 'id' | 'name'>,
): string {
  const slug =
    project.name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'project';
  return `project-${slug}-${project.id}`;
}

export const PROJECT_SUBMODULE_BASE = 'gitlink';

/**
 * The session's frozen snapshot with every member (a conversation is created from
 * the group as configured, never a subset). Undefined with fewer than two members:
 * that is the single-repository flow.
 */
export function buildSessionProjectRun(
  project: WorkspaceProject,
): SessionProjectRun | undefined {
  if (project.members.length < 2) return undefined;
  const paths = resolveProjectMemberPaths(project.members);
  return {
    id: project.id,
    name: project.name,
    ...(project.instructions !== undefined
      ? { instructions: project.instructions }
      : {}),
    root: getProjectRunRoot(project),
    members: Object.fromEntries(
      project.members.map((member, o) => [
        member.id,
        {
          o,
          src: member.source,
          placement: member.placement,
          path: paths[member.id]!,
          base:
            member.placement.kind === 'submodule'
              ? PROJECT_SUBMODULE_BASE
              : (member.source.baseBranch ?? 'HEAD'),
        },
      ]),
    ),
  };
}

/**
 * The one machine a group must run on, from its local members. `null` when it has
 * none and may run anywhere; `conflict` when they are on different machines.
 */
export function getProjectBoundMachineId(
  members: readonly Pick<ProjectMember, 'source'>[],
): string | null | 'conflict' {
  let machineId: string | null = null;
  for (const { source } of members) {
    if (source.kind !== 'local') continue;
    if (machineId !== null && machineId !== source.machineId) return 'conflict';
    machineId = source.machineId;
  }
  return machineId;
}

/**
 * The legacy `project` field: the first member, so older clients still show a
 * repository, a branch and a PR. `HEAD` is the placeholder the snapshot uses.
 */
export function buildProjectGroupProjectRef(
  member: ProjectMember,
): Record<string, string | boolean> {
  return member.source.kind === 'github'
    ? {
        kind: 'github',
        repoFullName: member.source.repoFullName,
        branch: member.source.baseBranch ?? 'HEAD',
      }
    : {
        kind: 'local',
        localProjectId: member.source.localProjectId,
        ...(member.source.baseBranch
          ? { branch: member.source.baseBranch }
          : {}),
        useWorktree: true,
      };
}

/** A group as the new-chat picker lists it. */
export type ProjectGroupItem = {
  id: string;
  name: string;
  /** The machine its local members pin; null runs anywhere; `conflict` cannot run. */
  machineId: string | null;
  conflict: boolean;
  members: {
    id: string;
    kind: 'github' | 'local';
    label: string;
    repoFullName?: string;
    machineId?: string;
    localProjectId?: string;
    preferLocal?: boolean;
    path: string;
  }[];
};

export function projectGroupItems(
  projects: readonly WorkspaceProject[],
  localName: (machineId: string, localProjectId: string) => string | undefined,
): ProjectGroupItem[] {
  return projects.map((project) => {
    const bound = getProjectBoundMachineId(project.members);
    let paths: Record<string, string> = {};
    try {
      paths = resolveProjectMemberPaths(project.members);
    } catch {
      paths = {};
    }
    return {
      id: project.id,
      name: project.name,
      machineId: bound === 'conflict' ? null : bound,
      conflict: bound === 'conflict',
      members: project.members.map((member) => ({
        id: member.id,
        kind: member.source.kind,
        label:
          member.source.kind === 'github'
            ? member.source.repoFullName
            : (localName(
                member.source.machineId,
                member.source.localProjectId,
              ) ?? member.source.localProjectId),
        ...(member.source.kind === 'github'
          ? {
              repoFullName: member.source.repoFullName,
              ...(member.source.preferLocal ? { preferLocal: true } : {}),
            }
          : {
              machineId: member.source.machineId,
              localProjectId: member.source.localProjectId,
            }),
        path: paths[member.id] ?? '',
      })),
    };
  });
}
