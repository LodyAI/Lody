import {
  getCurrentPullRequestsByRepository,
  parseGitHubPullRequestUrl,
  type PrStatus,
  type ProjectMemberId,
  type SessionMeta,
  type SessionProjectMember,
  type SessionPullRequestCiState,
} from '@lody/shared';

/** One repository of a multi-repository conversation, as the Info Bar lists it. */
export type SessionProjectMemberRow = {
  id: ProjectMemberId;
  /** Path under the conversation's main directory, e.g. `api/proto`. */
  path: string;
  kind: 'github' | 'local';
  isSubmodule: boolean;
  /** Nesting depth in the placement forest; roots are 0. */
  depth: number;
  /**
   * How the member reached the agent. `additional` and `link` are local
   * directories used in place: no branch, no backup, no PR.
   */
  access?: 'worktree' | 'additional' | 'link';
  /** GitHub repository, when known; local members learn it from their remote. */
  repoFullName?: string;
  branch?: string;
  /** Observed line changes for this Member, when the daemon has them. */
  diff?: { add: number; del: number };
  pr?: { url: string; number: number; status: PrStatus; ciState?: SessionPullRequestCiState };
};

/**
 * The repository a member's PRs live in. A GitHub member names it in its
 * frozen source; a local member's comes from the remote its machine observed,
 * which the daemon publishes beside the other runtime fields.
 */
function getSessionProjectMemberRepository(member: SessionProjectMember): string | undefined {
  return member.src.kind === 'github' ? member.src.repoFullName : member.repoFullName;
}

/**
 * Rows in placement order — each root followed by its submodules, siblings in
 * snapshot order — so the panel can show the nesting the conversation has.
 * Each row also carries the current PR of its repository. "Current" is per
 * repository — the last PR recorded for it — so a conversation with three
 * repositories has up to three current PRs.
 */
export function buildSessionProjectMemberRows(
  meta: Pick<SessionMeta, 'projectRun' | 'pullRequests' | 'pullRequestState'>
): SessionProjectMemberRow[] {
  const run = meta.projectRun;
  if (!run) return [];
  const currentByRepo = new Map<string, { url: string; status: PrStatus; number: number }>();
  for (const pr of getCurrentPullRequestsByRepository(meta.pullRequests ?? [])) {
    const parsed = parseGitHubPullRequestUrl(pr.url);
    if (parsed) {
      currentByRepo.set(parsed.repoFullName.toLowerCase(), {
        url: pr.url,
        status: pr.status,
        number: parsed.prNumber,
      });
    }
  }

  const entries = Object.entries(run.members).sort(([, left], [, right]) => left.o - right.o);
  const children = new Map<ProjectMemberId | null, Array<[string, SessionProjectMember]>>();
  for (const [id, member] of entries) {
    const parent = member.placement.kind === 'submodule' ? member.placement.parent : null;
    const siblings = children.get(parent) ?? [];
    siblings.push([id, member]);
    children.set(parent, siblings);
  }

  const rows: SessionProjectMemberRow[] = [];
  const visited = new Set<string>();
  const visit = ([id, member]: [string, SessionProjectMember], depth: number) => {
    if (visited.has(id)) return;
    visited.add(id);
    const memberId = id as ProjectMemberId;
    const repoFullName = getSessionProjectMemberRepository(member);
    const pr = repoFullName ? currentByRepo.get(repoFullName.toLowerCase()) : undefined;
    const ciState = pr ? meta.pullRequestState?.[pr.url]?.s : undefined;
    rows.push({
      id: memberId,
      path: member.path,
      kind: member.src.kind,
      isSubmodule: member.placement.kind === 'submodule',
      depth,
      ...(member.access ? { access: member.access } : {}),
      ...(repoFullName ? { repoFullName } : {}),
      ...(member.branch ? { branch: member.branch } : {}),
      ...(member.diff ? { diff: member.diff } : {}),
      ...(pr ? { pr: { ...pr, ...(ciState ? { ciState } : {}) } } : {}),
    });
    for (const child of children.get(memberId) ?? []) visit(child, depth + 1);
  };

  // A malformed snapshot is rejected when it is written, but tolerate a parent
  // that is not present instead of dropping every orphan row.
  const roots = entries.filter(([, member]) => {
    if (member.placement.kind !== 'submodule') return true;
    return !run.members[member.placement.parent];
  });
  for (const root of roots) visit(root, 0);
  for (const entry of entries) visit(entry, 0);
  return rows;
}

/** The row a conversation should describe: the explicit selection, else the
 *  legacy first-Member projection, else the first row. */
export function resolveSessionProjectMemberRow(
  rows: readonly SessionProjectMemberRow[],
  selectedMemberId: ProjectMemberId | null | undefined,
  fallbackRepoFullName?: string | null
): SessionProjectMemberRow | null {
  return (
    rows.find((row) => row.id === selectedMemberId) ??
    (fallbackRepoFullName
      ? rows.find((row) => row.repoFullName?.toLowerCase() === fallbackRepoFullName.toLowerCase())
      : undefined) ??
    rows[0] ??
    null
  );
}
