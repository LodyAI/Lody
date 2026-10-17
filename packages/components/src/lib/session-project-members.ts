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
  /** GitHub repository, when known; local members learn it from their remote. */
  repoFullName?: string;
  branch?: string;
  dirty: boolean;
  unpushed: boolean;
  pr?: { url: string; number: number; status: PrStatus; ciState?: SessionPullRequestCiState };
};

/**
 * The repository a member's PRs live in. A GitHub member names it in its
 * frozen source; a local member's comes from the remote its machine observed,
 * which the daemon publishes beside the other runtime fields.
 */
export function getSessionProjectMemberRepository(
  member: SessionProjectMember
): string | undefined {
  return member.src.kind === 'github' ? member.src.repoFullName : member.repoFullName;
}

/**
 * Rows in the snapshot's order, each with the current PR of its repository.
 * "Current" is per repository — the last PR recorded for it — so a
 * conversation with three repositories has up to three current PRs.
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
  return Object.entries(run.members)
    .sort(([, left], [, right]) => left.o - right.o)
    .map(([id, member]) => {
      const repoFullName = getSessionProjectMemberRepository(member);
      const pr = repoFullName ? currentByRepo.get(repoFullName.toLowerCase()) : undefined;
      const ciState = pr ? meta.pullRequestState?.[pr.url]?.s : undefined;
      return {
        id: id as ProjectMemberId,
        path: member.path,
        kind: member.src.kind,
        isSubmodule: member.placement.kind === 'submodule',
        ...(repoFullName ? { repoFullName } : {}),
        ...(member.branch ? { branch: member.branch } : {}),
        dirty: member.dirty === true,
        unpushed: member.unpushed === true,
        ...(pr ? { pr: { ...pr, ...(ciState ? { ciState } : {}) } } : {}),
      };
    });
}
