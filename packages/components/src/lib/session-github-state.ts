import type {
  SessionMeta,
  SessionPullRequestMeta,
  SessionPullRequestStateMeta,
} from '@lody/shared';
import {
  getSessionPullRequestLegacyFields,
  resolveSessionPullRequests,
  type SessionPullRequestSource,
  parseGitHubPullRequestUrl,
  resolveProjectGitHubRepo,
} from '@lody/shared';

export type SessionGitHubState = {
  /** The session owning the PR, also used for server-side repository identity. */
  sourceSessionId: SessionMeta['id'] | undefined;
  repoFullName: string;
  latestPr: SessionPullRequestMeta | null;
  latestPrState: SessionPullRequestStateMeta | null;
  canShowGitHubActions: boolean;
  hasExistingPr: boolean;
  workspaceDirty: boolean;
  /**
   * Committed but not on the remote. Independent of `workspaceDirty`, which
   * goes false the moment the agent commits while the PR head stays behind —
   * together they answer "is the PR head the author's latest work?".
   */
  workspaceUnpushed: boolean;
  /**
   * Whether the session has any changes to base a PR on — uncommitted
   * (`workspaceDirty`) OR already committed (`diffStats.allChange > 0`). These
   * two signals come from independent writers (post-turn `git status` vs the
   * Code Collab file-index scanner), so together they survive one being stale
   * and, unlike `workspaceDirty` alone, keep "Create PR" available after the
   * agent commits (clean tree, real commits, still no PR).
   */
  hasChanges: boolean;
};

export const getLatestPullRequest = (
  session: SessionPullRequestSource | null | undefined
): SessionPullRequestMeta | null => {
  const prList = resolveSessionPullRequests(session);
  if (!prList.length) {
    return null;
  }
  if (!prList.some((pr) => getSessionPullRequestLegacyFields(pr).reportedAt)) {
    return prList[prList.length - 1] ?? null;
  }
  return prList.toSorted((a, b) => comparePullRequestRecency(a, b))[0] ?? null;
};

/**
 * The current PR of one repository. A multi-repository Session records PRs of
 * several repositories in one list; its context stage describes the first
 * member, so it must show that repository's PR, never another one's.
 */
export const getLatestPullRequestForRepository = (
  session: SessionPullRequestSource | null | undefined,
  repoFullName: string
): SessionPullRequestMeta | null => {
  const target = repoFullName.toLowerCase();
  const matching = resolveSessionPullRequests(session).filter(
    (pr) => parseGitHubPullRequestUrl(pr.url)?.repoFullName.toLowerCase() === target
  );
  return getLatestPullRequest({ pullRequests: matching });
};

const comparePullRequestRecency = (
  left: SessionPullRequestMeta,
  right: SessionPullRequestMeta
): number => {
  const leftReportedAt = getSessionPullRequestLegacyFields(left).reportedAt ?? '';
  const rightReportedAt = getSessionPullRequestLegacyFields(right).reportedAt ?? '';
  if (leftReportedAt || rightReportedAt) {
    return rightReportedAt.localeCompare(leftReportedAt);
  }
  return 0;
};

export const getPullRequestNumber = (
  pr: SessionPullRequestMeta | null | undefined
): number | null =>
  typeof getSessionPullRequestLegacyFields(pr).number === 'number' &&
  Number.isFinite(getSessionPullRequestLegacyFields(pr).number)
    ? (getSessionPullRequestLegacyFields(pr).number ?? null)
    : pr?.url
      ? (parseGitHubPullRequestUrl(pr.url)?.prNumber ?? null)
      : null;

export const getPullRequestRepoFullName = (
  pr: SessionPullRequestMeta | null | undefined
): string | null =>
  getSessionPullRequestLegacyFields(pr).repository?.trim() ||
  (pr?.url ? (parseGitHubPullRequestUrl(pr.url)?.repoFullName ?? null) : null);

export const resolveWorkspaceOwnerSession = (
  session: SessionMeta | null | undefined,
  workspaceSession?: SessionMeta | null
): SessionMeta | null => workspaceSession ?? session ?? null;

/**
 * The GitHub context of a conversation.
 *
 * `activeRepository` lets a multi-repository conversation describe the
 * repository the user selected instead of the legacy first-Member projection:
 * pass a repository name to describe it, `null` to describe a Member with no
 * GitHub remote (no PR or GitHub action), and omit it for the legacy default.
 */
export const getSessionGitHubState = (
  session: SessionMeta | null | undefined,
  workspaceSession?: SessionMeta | null,
  activeRepository?: string | null
): SessionGitHubState => {
  const sourceSession = resolveWorkspaceOwnerSession(session, workspaceSession);
  const legacyRepoFullName =
    (resolveProjectGitHubRepo(sourceSession?.project) ?? sourceSession?.repoFullName)?.trim() ?? '';
  const repoFullName =
    activeRepository === undefined ? legacyRepoFullName : (activeRepository?.trim() ?? '');
  const latestPr =
    sourceSession?.projectRun || activeRepository !== undefined
      ? repoFullName
        ? getLatestPullRequestForRepository(sourceSession, repoFullName)
        : null
      : getLatestPullRequest(sourceSession);
  const latestPrState = latestPr?.url
    ? (sourceSession?.pullRequestState?.[latestPr.url] ?? null)
    : null;

  const workspaceDirty = sourceSession?.workspaceDirty ?? false;
  const workspaceUnpushed = sourceSession?.workspaceUnpushed ?? false;
  const allChange = sourceSession?.diffStats?.allChange;
  const hasCommittedDiff = allChange ? allChange.add + allChange.del > 0 : false;
  // `diffStats` is published only when every Member reports a diff, and a
  // non-Git Member never does. Fall back to the Member rows so committed work
  // still enables Create PR in a mixed Project group.
  const memberHasCommittedDiff = sourceSession?.projectRun
    ? Object.values(sourceSession.projectRun.members).some(
        (member) => member.diff && member.diff.add + member.diff.del > 0
      )
    : false;

  return {
    sourceSessionId: sourceSession?.id,
    repoFullName,
    latestPr,
    latestPrState,
    canShowGitHubActions: !!repoFullName,
    hasExistingPr: !!repoFullName && !!latestPr,
    workspaceDirty,
    workspaceUnpushed,
    hasChanges: workspaceDirty || hasCommittedDiff || memberHasCommittedDiff,
  };
};
