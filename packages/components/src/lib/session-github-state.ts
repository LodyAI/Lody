import type {
  SessionMeta,
  SessionPullRequestMeta,
  SessionPullRequestStateMeta,
} from '@lody/shared';
import {
  getSessionPullRequestLegacyFields,
  parseGitHubPullRequestUrl,
  resolveProjectGitHubRepo,
} from '@lody/shared';

export type SessionGitHubState = {
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
  session: Pick<SessionMeta, 'pullRequests'> | null | undefined
): SessionPullRequestMeta | null => {
  const prList = session?.pullRequests ?? [];
  if (!prList.length) {
    return null;
  }
  if (!prList.some((pr) => getSessionPullRequestLegacyFields(pr).reportedAt)) {
    return prList[prList.length - 1] ?? null;
  }
  return prList.toSorted((a, b) => comparePullRequestRecency(a, b))[0] ?? null;
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

export const getSessionGitHubState = (
  session: SessionMeta | null | undefined,
  workspaceSession?: SessionMeta | null
): SessionGitHubState => {
  const sourceSession = resolveWorkspaceOwnerSession(session, workspaceSession);
  const repoFullName =
    (resolveProjectGitHubRepo(sourceSession?.project) ?? sourceSession?.repoFullName)?.trim() ?? '';
  const latestPr = getLatestPullRequest(sourceSession);
  const latestPrState = latestPr?.url
    ? (sourceSession?.pullRequestState?.[latestPr.url] ?? null)
    : null;

  const workspaceDirty = sourceSession?.workspaceDirty ?? false;
  const workspaceUnpushed = sourceSession?.workspaceUnpushed ?? false;
  const allChange = sourceSession?.diffStats?.allChange;
  const hasCommittedDiff = allChange ? allChange.add + allChange.del > 0 : false;

  return {
    repoFullName,
    latestPr,
    latestPrState,
    canShowGitHubActions: !!repoFullName,
    hasExistingPr: !!repoFullName && !!latestPr,
    workspaceDirty,
    workspaceUnpushed,
    hasChanges: workspaceDirty || hasCommittedDiff,
  };
};
