import type {
  SessionMeta,
  SessionPullRequestMeta,
  SessionPullRequestStateMeta,
} from '@lody/shared';
import {
  getSessionPullRequestLegacyFields,
  hasWorkspaceChanges,
  resolveSessionPrimaryPullRequest,
  resolveSessionPullRequestHistory,
  type SessionPullRequestView,
  parseGitHubPullRequestUrl,
  resolveProjectGitHubRepo,
} from '@lody/shared';

export type SessionGitHubState = {
  /** The session owning the PR, also used for server-side repository identity. */
  sourceSessionId: SessionMeta['id'] | undefined;
  repoFullName: string;
  /** Shared summary of the described PR; every surface reads the same view. */
  latestPrView: SessionPullRequestView | null;
  /** Every associated PR in the described scope: `latestPrView` first, then
   *  older associations newest first. Never shrinks when a newer PR appears. */
  pullRequestHistory: SessionPullRequestView[];
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
   * Whether the session has changes to base a PR on. Workspace diff totals
   * include committed and uncommitted changes against the workspace base.
   * `workspaceDirty` also covers changes without text-line counts and remains
   * independent of the asynchronously refreshed comparison summary.
   */
  hasChanges: boolean;
};

export const getPullRequestNumber = (
  pr: SessionPullRequestMeta | null | undefined
): number | null => {
  const parsed = pr?.url ? parseGitHubPullRequestUrl(pr.url)?.prNumber : undefined;
  if (parsed !== undefined) return parsed;
  const legacy = getSessionPullRequestLegacyFields(pr).number;
  return typeof legacy === 'number' && Number.isFinite(legacy) ? legacy : null;
};

export const getPullRequestRepoFullName = (
  pr: SessionPullRequestMeta | null | undefined
): string | null =>
  (pr?.url ? parseGitHubPullRequestUrl(pr.url)?.repoFullName : undefined) ??
  (getSessionPullRequestLegacyFields(pr).repository?.trim() || null);

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
  const describedRepository =
    activeRepository === undefined && !sourceSession?.projectRun ? undefined : repoFullName || null;
  const latestPrView = resolveSessionPrimaryPullRequest(sourceSession, describedRepository);
  const pullRequestHistory = resolveSessionPullRequestHistory(sourceSession, describedRepository);
  const latestPr = latestPrView?.pr ?? null;
  const latestPrState = latestPrView?.state ?? null;

  const workspaceDirty = sourceSession?.workspaceDirty ?? false;
  const workspaceUnpushed = sourceSession?.workspaceUnpushed ?? false;
  const allChange = sourceSession?.diffStats?.allChange;
  const hasWorkspaceDiff = hasWorkspaceChanges(allChange);
  // A group total can be unknown while some Members have a complete comparison.
  const memberHasWorkspaceDiff = sourceSession?.projectRun
    ? Object.values(sourceSession.projectRun.members).some(
        (member) => hasWorkspaceChanges(member.diff)
      )
    : false;

  return {
    sourceSessionId: sourceSession?.id,
    repoFullName,
    latestPrView,
    pullRequestHistory,
    latestPr,
    latestPrState,
    canShowGitHubActions: !!repoFullName,
    hasExistingPr: !!repoFullName && !!latestPr,
    workspaceDirty,
    workspaceUnpushed,
    hasChanges: workspaceDirty || hasWorkspaceDiff || memberHasWorkspaceDiff,
  };
};
