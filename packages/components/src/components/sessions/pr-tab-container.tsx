'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { GitHubMergeMethod, PrStatus } from '@lody/shared';

import { currentWorkspaceIdAtom } from '@/atoms';
import { derivePrStatusFromDetails } from '@/lib/github-pr-details-state';
import { getDurationSinceMs, getPerformanceNowMs } from '@/lib/posthog-analytics';
import {
  isGitHubOperationTokenConnectionLostError,
  isGitHubUnauthorizedTokenError,
} from '@/lib/github-token';
import { ReadyForReviewStillDraftError, useGitHubPrDetails } from '@/hooks/use-github-pr-details';
import { PrTabView, type PrTabViewData, type PrTabViewState } from './pr-tab-view';
import { resolveConflictsActionAtomFamily } from './session-pr-agent-action';
import {
  capturePrMergeFailed,
  capturePrMergeRequested,
  capturePrMergeSucceeded,
  classifyMergeError,
  resolveCiAnalyticsStatus,
  resolvePrAnalyticsStatus,
} from './diff-pr-analytics';
import { setPreferredPrMergeMethod, usePreferredPrMergeMethod } from './pr-merge-method';

export interface PrTabContainerProps {
  repoFullName: string;
  prNumber: number;
  headCommitSha?: string | null;
  leadingSlot?: React.ReactNode;
  className?: string;
  /**
   * Whether this tab is on screen. It stays mounted while the side panel is
   * collapsed, so GitHub polling has to pause on the caller's word.
   */
  visible?: boolean;
  /** Session this PR tab belongs to, for analytics breakdown (spec §8d). */
  sessionId?: string | null;
  /**
   * Fired when the live PR details resolve to a coarse {@link PrStatus},
   * letting the owner reconcile the persisted session PR status (which drives
   * the sidebar + session-header badges) against GitHub's live truth — most
   * visibly `draft`, which the webhook/CLI may not have propagated yet.
   */
  onResolvedPrStatus?: (status: PrStatus) => void;
}

function resolveGitHubAppInstallUrl(): string {
  const appName = (import.meta.env.VITE_GITHUB_APP_NAME as string | undefined) || 'lodyai';
  return `https://github.com/apps/${appName}/installations/new`;
}

const NOT_AUTHENTICATED_ERROR_MESSAGE = 'Not authenticated. Please sign in.';

function isRecoverableReadyForReviewAuthError(error: unknown): boolean {
  if (isGitHubUnauthorizedTokenError(error)) return true;
  return error instanceof Error && error.message === NOT_AUTHENTICATED_ERROR_MESSAGE;
}

export function PrTabContainer({
  repoFullName,
  prNumber,
  headCommitSha,
  leadingSlot,
  className,
  sessionId,
  visible = true,
  onResolvedPrStatus,
}: PrTabContainerProps) {
  const { t } = useTranslation();
  const postHog = usePostHog();
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const {
    state,
    data,
    error,
    checksPermissionError,
    refresh,
    postComment,
    isPostingComment,
    mergePullRequest,
    isMerging,
    setPullRequestState,
    isUpdatingState,
    markReadyForReview,
    isMarkingReady,
    deleteBranch,
    isDeletingBranch,
    branchExists,
    isRevalidating,
  } = useGitHubPrDetails({
    workspaceId: currentWorkspaceId ?? null,
    repoFullName,
    prNumber,
    headCommitSha,
    visible,
  });
  const mergeMethod = usePreferredPrMergeMethod();
  // The owning session (this PR tab's session) publishes the live resolve-
  // conflicts action; consuming it here keeps the PR-tab button in lockstep with
  // the info-bar "Resolve Conflicts" button (same dispatch, shared pending).
  const resolveConflictsAction = useAtomValue(
    resolveConflictsActionAtomFamily(sessionId ?? '')
  );
  const canResolveConflicts = Boolean(
    resolveConflictsAction?.available && !resolveConflictsAction.pending
  );

  const analyticsBase = useMemo(
    () => ({
      workspaceId: currentWorkspaceId ?? null,
      sessionId: sessionId ?? null,
      repoFullName,
      prNumber,
    }),
    [currentWorkspaceId, prNumber, repoFullName, sessionId]
  );

  const pullRequest = data?.pullRequest ?? null;

  // Reconcile the persisted session PR status from GitHub's live truth. The
  // sidebar + session-header badges read the persisted `status`, which the
  // webhook/CLI own; until those propagate (notably `draft`), this is the only
  // surface that knows the real state. Fire once per resolved status so the
  // owner's write doesn't loop.
  const lastResolvedStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pullRequest || !onResolvedPrStatus) return;
    const status = derivePrStatusFromDetails(pullRequest);
    const key = `${pullRequest.number}:${status}`;
    if (lastResolvedStatusRef.current === key) return;
    lastResolvedStatusRef.current = key;
    onResolvedPrStatus(status);
  }, [onResolvedPrStatus, pullRequest]);

  const handleSelectMergeMethod = useCallback((method: GitHubMergeMethod) => {
    setPreferredPrMergeMethod(method);
  }, []);

  const handleMerge = useCallback(
    async (method: GitHubMergeMethod) => {
      const pr = data?.pullRequest ?? null;
      capturePrMergeRequested(postHog, analyticsBase, {
        mergeMethod: method,
        prStatus: resolvePrAnalyticsStatus(pr),
        ciStatus: resolveCiAnalyticsStatus(data?.checkRuns),
      });
      const startedAt = getPerformanceNowMs();
      try {
        await mergePullRequest(method);
        capturePrMergeSucceeded(postHog, analyticsBase, {
          mergeMethod: method,
          durationMs: getDurationSinceMs(startedAt),
        });
      } catch (err) {
        capturePrMergeFailed(postHog, analyticsBase, {
          mergeMethod: method,
          errorKind: classifyMergeError(err, pr),
          durationMs: getDurationSinceMs(startedAt),
        });
        // The request only obtains the credential used for the subsequent
        // GitHub merge. If Convex disconnects here, the merge was never sent;
        // the retry above has already had a chance to recover, so leave the
        // action ready to try again instead of exposing a backend transport
        // detail as a merge failure.
        if (isGitHubOperationTokenConnectionLostError(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        toast.error(t('sessions.prTab.mergeError', 'Failed to merge'), { description: message });
      }
    },
    [analyticsBase, data?.checkRuns, data?.pullRequest, mergePullRequest, postHog, t]
  );

  const handleSetState = useCallback(
    async (nextState: 'open' | 'closed') => {
      try {
        await setPullRequestState(nextState);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(
          nextState === 'closed'
            ? t('sessions.prTab.closeError', 'Failed to close pull request')
            : t('sessions.prTab.reopenError', 'Failed to reopen pull request'),
          { description: message }
        );
      }
    },
    [setPullRequestState, t]
  );

  const handleMarkReadyForReview = useCallback(async () => {
    try {
      await markReadyForReview();
    } catch (err) {
      let errorForToast: unknown = err;
      if (isRecoverableReadyForReviewAuthError(err)) {
        try {
          await refresh();
          await markReadyForReview();
          return;
        } catch (retryErr) {
          errorForToast = retryErr;
        }
      }
      const message =
        errorForToast instanceof ReadyForReviewStillDraftError
          ? t(
              'sessions.prTab.readyForReviewStillDraft',
              'GitHub is still reporting this pull request as a draft. Try again in a moment.'
            )
          : errorForToast instanceof Error
            ? errorForToast.message
            : String(errorForToast);
      toast.error(t('sessions.prTab.readyForReviewError', 'Failed to mark as ready for review'), {
        description: message,
      });
    }
  }, [markReadyForReview, refresh, t]);

  const handleDeleteBranch = useCallback(async () => {
    try {
      await deleteBranch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t('sessions.prTab.deleteBranchError', 'Failed to delete branch'), {
        description: message,
      });
    }
  }, [deleteBranch, t]);

  const handlePostComment = useCallback(
    async (body: string) => {
      try {
        await postComment(body);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(t('sessions.prTab.postCommentError', 'Failed to post comment'), {
          description: message,
        });
        throw err;
      }
    },
    [postComment, t]
  );

  const viewState: PrTabViewState =
    state === 'idle' || state === 'loading' ? 'loading' : state === 'error' ? 'error' : 'ready';

  const viewData: PrTabViewData | null = useMemo(() => {
    if (!data) return null;
    return {
      pullRequest: data.pullRequest,
      reviewThreads: data.reviewThreads,
      reviews: data.reviews,
      issueComments: data.issueComments,
      checkRuns: data.checkRuns,
    };
  }, [data]);

  const handleRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  const handleGrantChecksPermission = useCallback(() => {
    window.open(resolveGitHubAppInstallUrl(), '_blank', 'noopener,noreferrer');
  }, []);

  return (
    <PrTabView
      repoFullName={repoFullName}
      prNumber={prNumber}
      state={viewState}
      data={viewData}
      error={error?.message ?? null}
      isRefreshing={isRevalidating}
      isPostingComment={isPostingComment}
      checksPermissionError={checksPermissionError}
      leadingSlot={leadingSlot}
      mergeMethod={mergeMethod}
      isMerging={isMerging}
      isUpdatingState={isUpdatingState}
      isMarkingReady={isMarkingReady}
      isDeletingBranch={isDeletingBranch}
      branchExists={branchExists}
      onSelectMergeMethod={handleSelectMergeMethod}
      onMerge={handleMerge}
      onSetState={handleSetState}
      onMarkReadyForReview={handleMarkReadyForReview}
      onDeleteBranch={handleDeleteBranch}
      onResolveConflicts={canResolveConflicts ? resolveConflictsAction?.run : undefined}
      isResolvingConflicts={resolveConflictsAction?.pending ?? false}
      onRefresh={handleRefresh}
      onPostComment={handlePostComment}
      onGrantChecksPermission={handleGrantChecksPermission}
      className={className}
    />
  );
}
