import { z } from 'zod';
import type { MachineId } from './ids';
import type { LocalProjectId } from './project';
import type { LineChange } from './schema';
import { parseGitHubPullRequestUrl } from './github-url';

export type ProjectId = string & { __brand: 'ProjectId' };
export type ProjectMemberId = string & { __brand: 'ProjectMemberId' };
export type ProjectMemberSource =
  | { kind: 'github'; repoFullName: string; repoId?: number; baseBranch?: string }
  | { kind: 'local'; machineId: MachineId; localProjectId: LocalProjectId; baseBranch?: string };
export type ProjectMemberPlacement =
  | { kind: 'root'; dir: string }
  | { kind: 'submodule'; parent: ProjectMemberId; path: string };
export type ProjectMember = {
  id: ProjectMemberId;
  source: ProjectMemberSource;
  placement: ProjectMemberPlacement;
};
export type WorkspaceProject = {
  v: 1;
  id: ProjectId;
  name: string;
  instructions?: string;
  ownerUserId: string;
  createdAtMs: number;
  revision: number;
  members: ProjectMember[];
};
export type SessionProjectMember = {
  /** Owner-observed GitHub identity, including local members with a GitHub remote. */
  repoFullName?: string;
  o: number;
  src: ProjectMemberSource;
  placement: ProjectMemberPlacement;
  path: string;
  base: string;
  branch?: string;
  dirty?: boolean;
  unpushed?: boolean;
  diff?: LineChange;
};
/** One atomic metadata value. Clients write the creation snapshot only.
 * Afterwards the owning daemon serializes all read-modify-write operations per session.
 * A second writer requires separate member rows; nested records do not merge.
 */
export type SessionProjectRun = {
  id: ProjectId;
  name: string;
  instructions?: string;
  root: string;
  members: Record<ProjectMemberId, SessionProjectMember>;
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
          !/^(?:\.git|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  );
}
const pathSchema = z.string().refine(isSafeProjectPath);
const segmentSchema = pathSchema.refine((value) => !value.includes('/'));
export const ProjectIdSchema = z
  .string()
  .uuid()
  .transform((value) => value as ProjectId);
export const ProjectMemberIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value))
  .transform((value) => value as ProjectMemberId);
export const ProjectMemberSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('github'),
    repoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    repoId: z.number().int().positive().optional(),
    baseBranch: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('local'),
    machineId: z
      .string()
      .min(1)
      .transform((value) => value as MachineId),
    localProjectId: z
      .string()
      .min(1)
      .transform((value) => value as LocalProjectId),
    baseBranch: z.string().min(1).optional(),
  }),
]);
export const ProjectMemberPlacementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root'), dir: segmentSchema }),
  z.object({ kind: z.literal('submodule'), parent: ProjectMemberIdSchema, path: pathSchema }),
]);
export const ProjectMemberSchema = z.object({
  id: ProjectMemberIdSchema,
  source: ProjectMemberSourceSchema,
  placement: ProjectMemberPlacementSchema,
});

/** Resolves the frozen placement forest; rejects missing parents, cycles and overlapping siblings. */
export function resolveProjectMemberPaths(
  members: readonly ProjectMember[]
): Record<ProjectMemberId, string> {
  const byId = new Map(members.map((member) => [member.id, member]));
  if (byId.size !== members.length) throw new Error('Duplicate Project Member ID');
  const paths = Object.create(null) as Record<ProjectMemberId, string>;
  const visiting = new Set<ProjectMemberId>();
  const visit = (id: ProjectMemberId): string => {
    if (paths[id]) return paths[id];
    const member = byId.get(id);
    if (!member || visiting.has(id)) throw new Error('Invalid Project Member parent');
    visiting.add(id);
    const p = member.placement;
    const suffix = p.kind === 'root' ? p.dir : p.path;
    if (!isSafeProjectPath(suffix) || (p.kind === 'root' && suffix.includes('/')))
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
      const ancestor = (parent: ProjectMemberId, child: ProjectMember): boolean => {
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
function validMembers(members: ProjectMember[]): boolean {
  try {
    resolveProjectMemberPaths(members);
    return deduplicateProjectMembers(members).length === members.length;
  } catch {
    return false;
  }
}
export const WorkspaceProjectSchema = z.object({
  v: z.literal(1),
  id: ProjectIdSchema,
  name: z.string().trim().min(1),
  instructions: z.string().optional(),
  ownerUserId: z.string().min(1),
  createdAtMs: z.number().finite().nonnegative(),
  revision: z.number().int().positive(),
  members: z.array(ProjectMemberSchema).min(1).refine(validMembers),
});
export function normalizeWorkspaceProject(value: unknown): WorkspaceProject | undefined {
  const result = WorkspaceProjectSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
export const SessionProjectMemberSchema = z.object({
  repoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  o: z.number().int().nonnegative(),
  src: ProjectMemberSourceSchema,
  placement: ProjectMemberPlacementSchema,
  path: pathSchema,
  base: z.string().min(1),
  branch: z.string().min(1).optional(),
  dirty: z.boolean().optional(),
  unpushed: z.boolean().optional(),
  diff: z
    .object({ add: z.number().int().nonnegative(), del: z.number().int().nonnegative() })
    .optional(),
});
export const SessionProjectRunSchema = z
  .object({
    id: ProjectIdSchema,
    name: z.string().min(1),
    instructions: z.string().optional(),
    root: segmentSchema,
    members: z.record(ProjectMemberIdSchema, SessionProjectMemberSchema),
  })
  .refine((run) => {
    const members = Object.entries(run.members).map(([id, m]) => ({
      id: id as ProjectMemberId,
      source: m.src,
      placement: m.placement,
    }));
    if (members.length < 2 || !validMembers(members)) return false;
    const paths = resolveProjectMemberPaths(members);
    const orders = new Set<number>();
    for (const [id, m] of Object.entries(run.members)) {
      if (paths[id as ProjectMemberId] !== m.path || orders.has(m.o)) return false;
      orders.add(m.o);
    }
    return /^project-[a-z0-9-]+-/.test(run.root) && run.root.endsWith(`-${run.id}`);
  });
export function getProjectRunRoot(project: Pick<WorkspaceProject, 'id' | 'name'>): string {
  const slug =
    project.name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'project';
  return `project-${slug}-${project.id}`;
}

export type ProjectRepositoryIdentity = { repoFullName: string; repoId?: number };
export type ResolveLocalProjectRepository = (
  source: Extract<ProjectMemberSource, { kind: 'local' }>
) => ProjectRepositoryIdentity | undefined;
/** Local identity resolution is supplied by the owning machine; no host paths enter synced data. */
export function deduplicateProjectMembers(
  members: readonly ProjectMember[],
  resolveLocal?: ResolveLocalProjectRepository
): ProjectMember[] {
  const identities = members.map((m) =>
    m.source.kind === 'github' ? m.source : resolveLocal?.(m.source)
  );
  const knownIds = new Map<string, Set<number>>();
  for (const repo of identities)
    if (repo?.repoId !== undefined) {
      const name = repo.repoFullName.toLowerCase();
      const ids = knownIds.get(name) ?? new Set<number>();
      ids.add(repo.repoId);
      knownIds.set(name, ids);
    }
  const seen = new Set<string>();
  return members.filter((m, i) => {
    const repo = identities[i];
    const name = repo?.repoFullName.toLowerCase();
    const ids = name ? knownIds.get(name) : undefined;
    const repoId = repo?.repoId ?? (ids?.size === 1 ? [...ids][0] : undefined);
    const key = repo
      ? repoId !== undefined
        ? `github-id:${repoId}`
        : `github:${name}`
      : m.source.kind === 'local'
        ? JSON.stringify(['local', m.source.machineId, m.source.localProjectId])
        : '';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
/** Last valid PR per repository, retaining the input order of those last occurrences. */
export function getCurrentPullRequestsByRepository<T extends { url: string }>(
  prs: readonly T[]
): T[] {
  const current = new Map<string, T>();
  for (const pr of prs) {
    const repo = parseGitHubPullRequestUrl(pr.url)?.repoFullName.toLowerCase();
    if (!repo) continue;
    current.delete(repo);
    current.set(repo, pr);
  }
  return [...current.values()];
}
