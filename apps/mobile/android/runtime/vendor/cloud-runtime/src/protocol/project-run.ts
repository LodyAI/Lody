import type { ProjectRun, ProjectRunMember } from '../models/catalog.ts';
import type { PullRequestReference } from '../models/pull-request.ts';

type Fields = Record<string, unknown>;
const object = (value: unknown): Fields =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Fields)
    : {};
const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/**
 * Web `buildSessionProjectMemberRows`: the members of a Project group conversation in
 * placement order (each root, then its submodules), each with the current PR of its
 * repository. "Current" is per repository, the last PR recorded for it, so three
 * repositories can have three current PRs.
 */
export function projectRunOf(
  value: unknown,
  pullRequests: readonly PullRequestReference[],
): ProjectRun | undefined {
  const run = object(value);
  const id = text(run.id);
  if (!id) return undefined;
  const current = new Map<string, PullRequestReference>();
  for (const pr of pullRequests) current.set(pr.repository.toLowerCase(), pr);

  type Entry = { id: string; member: Fields; order: number; parent: string };
  const entries: Entry[] = Object.entries(object(run.members))
    .map(([memberId, raw]) => {
      const member = object(raw);
      const placement = object(member.placement);
      return {
        id: memberId,
        member,
        order: count(member.o),
        parent: placement.kind === 'submodule' ? text(placement.parent) : '',
      };
    })
    .filter((entry) => entry.id && text(entry.member.path))
    .sort((left, right) => left.order - right.order);
  const known = new Set(entries.map((entry) => entry.id));
  const children = new Map<string, Entry[]>();
  for (const entry of entries) {
    // A missing parent keeps the member as a root instead of dropping it.
    const parent = known.has(entry.parent) ? entry.parent : '';
    children.set(parent, [...(children.get(parent) ?? []), entry]);
  }

  const members: ProjectRunMember[] = [];
  const visited = new Set<string>();
  const visit = (entry: Entry, depth: number) => {
    if (visited.has(entry.id)) return;
    visited.add(entry.id);
    const { member } = entry;
    const source = object(member.src);
    const kind = source.kind === 'local' ? 'local' : 'github';
    const repoFullName =
      kind === 'github' ? text(source.repoFullName) : text(member.repoFullName);
    const access = text(member.access);
    const diff = object(member.diff);
    const add = count(diff.add),
      del = count(diff.del);
    const pullRequest = repoFullName
      ? current.get(repoFullName.toLowerCase())
      : undefined;
    members.push({
      id: entry.id,
      path: text(member.path),
      kind,
      depth,
      submodule: entry.parent !== '',
      ...(access === 'worktree' || access === 'additional' || access === 'link'
        ? { access }
        : {}),
      ...(repoFullName ? { repoFullName } : {}),
      ...(text(member.branch) ? { branch: text(member.branch) } : {}),
      ...(add || del ? { diff: { add, del } } : {}),
      ...(member.dirty === true ? { dirty: true } : {}),
      ...(member.unpushed === true ? { unpushed: true } : {}),
      ...(pullRequest ? { pullRequest } : {}),
    });
    for (const child of children.get(entry.id) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get('') ?? []) visit(root, 0);
  // Placement cycles have no root; still list every member once.
  for (const entry of entries) visit(entry, 0);
  return { id, name: text(run.name), members };
}
