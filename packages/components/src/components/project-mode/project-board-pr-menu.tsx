import { useCallback, useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Spinner } from '@lody/ui/spinner';
import {
  getSessionPullRequestLegacyFields,
  type GitHubMergeMethod,
  type GitHubPullRequestDetails,
  type PrStatus,
  type SessionPullRequestView,
} from '@lody/shared';
import { usePlatformCapability } from '@lody/platform/react';
import { usePostHog } from '@posthog/react';
import { useAtomValue } from 'jotai';
import {
  ChevronDown,
  Copy,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestClosed,
  RotateCw,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { currentWorkspaceIdAtom } from '@/atoms';
import { parseGitHubReferenceUrl } from '@/components/ai-gui/github-reference-link';
import {
  capturePrMergeFailed,
  capturePrMergeRequested,
  capturePrMergeSucceeded,
  classifyMergeError,
  resolveCiAnalyticsStatus,
  resolvePrAnalyticsStatus,
} from '@/components/sessions/diff-pr-analytics';
import {
  setPreferredPrMergeMethod,
  usePreferredPrMergeMethod,
} from '@/components/sessions/pr-merge-method';
import { PR_STATUS_META } from '@/components/sessions/pull-request-badge';
import { resolveConflictsActionAtomFamily } from '@/components/sessions/session-pr-agent-action';
import { SessionPrIcon } from '@/components/sidebar-row-shared';
import { ReadyForReviewStillDraftError, useGitHubPrDetails } from '@/hooks/use-github-pr-details';
import { writeTextToClipboard } from '@/lib/clipboard';
import { isDraftPr, isPullRequestMergeabilityPending } from '@/lib/github-pr-details-state';
import {
  isGitHubOperationTokenConnectionLostError,
  isGitHubUnauthorizedTokenError,
} from '@/lib/github-token';
import { openExternalUrl } from '@/lib/native-browser';
import { getDurationSinceMs, getPerformanceNowMs } from '@/lib/posthog-analytics';
import { toast } from '@/lib/toast';
import { Menu } from '@/ui/menu';

const styles = stylex.create({
  prButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    flexShrink: 0,
    paddingBlock: space[1],
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.medium,
    backgroundColor: { default: colors.wellBackground, ':hover': colors.hoverFill },
    color: colors.label,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
  },
  prStatus: { color: colors.secondaryLabel },
  prMergeable: { color: colors.success },
  chevron: { flexShrink: 0, color: colors.tertiaryLabel },
  spinner: { width: '14px', height: '14px', flexShrink: 0 },
});

const MERGE_METHOD_SPECS: ReadonlyArray<{
  method: GitHubMergeMethod;
  labelKey: string;
  labelFallback: string;
}> = [
  {
    method: 'squash',
    labelKey: 'sessions.prTab.mergeSquash',
    labelFallback: 'Squash and merge',
  },
  {
    method: 'merge',
    labelKey: 'sessions.prTab.mergeMerge',
    labelFallback: 'Create a merge commit',
  },
  {
    method: 'rebase',
    labelKey: 'sessions.prTab.mergeRebase',
    labelFallback: 'Rebase and merge',
  },
];

const NOT_AUTHENTICATED_ERROR_MESSAGE = 'Not authenticated. Please sign in.';

function isRecoverableReadyForReviewAuthError(error: unknown): boolean {
  if (isGitHubUnauthorizedTokenError(error)) return true;
  return error instanceof Error && error.message === NOT_AUTHENTICATED_ERROR_MESSAGE;
}

type MergeKind = 'ready' | 'conflict' | 'checking' | 'blocked' | 'draft' | 'merged' | 'closed';

function resolveMergeKind(pr: GitHubPullRequestDetails): MergeKind {
  if (pr.merged) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (isDraftPr(pr)) return 'draft';
  if (isPullRequestMergeabilityPending(pr)) return 'checking';
  if (pr.mergeable === false || pr.mergeableState === 'dirty') return 'conflict';
  if (pr.mergeableState === 'blocked' || pr.mergeableState === 'behind') return 'blocked';
  return 'ready';
}

export function ProjectBoardPrMenu({
  sessionId,
  pr,
  onOpenPr,
}: {
  sessionId: string;
  pr: SessionPullRequestView;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
}) {
  const { t } = useTranslation();
  const postHog = usePostHog();
  const hasHostedGitHub = usePlatformCapability('githubIntegration');
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const preferredMergeMethod = usePreferredPrMergeMethod();
  const resolveConflictsAction = useAtomValue(resolveConflictsActionAtomFamily(sessionId));

  const parsedUrl = useMemo(() => parseGitHubReferenceUrl(pr.url), [pr.url]);
  const repoFullName =
    pr.repoFullName?.trim() || (parsedUrl ? `${parsedUrl.owner}/${parsedUrl.repo}` : '');
  const prNumber = pr.number ?? (parsedUrl?.kind === 'pull' ? parsedUrl.number : null);

  const [open, setOpen] = useState(false);
  const [activated, setActivated] = useState(false);

  const details = useGitHubPrDetails({
    sessionId,
    workspaceId: currentWorkspaceId ?? null,
    repoFullName: repoFullName || null,
    prNumber,
    headCommitSha: getSessionPullRequestLegacyFields(pr.pr).headCommitSha,
    enabled: hasHostedGitHub && Boolean(repoFullName && prNumber !== null) && (open || activated),
    visible: open,
  });

  const livePr = details.data?.pullRequest ?? null;
  const busy =
    details.isMerging ||
    details.isUpdatingState ||
    details.isMarkingReady ||
    details.isDeletingBranch;

  const effectiveStatus: PrStatus = livePr
    ? livePr.merged
      ? 'merged'
      : livePr.state === 'closed'
        ? 'closed'
        : isDraftPr(livePr)
          ? 'draft'
          : 'open'
    : pr.status;

  const mergeKind = livePr ? resolveMergeKind(livePr) : null;
  const isMergeable = livePr
    ? mergeKind === 'ready'
    : pr.readiness === 'y' && pr.status !== 'merged' && pr.status !== 'closed';

  const statusMeta = PR_STATUS_META[effectiveStatus] ?? PR_STATUS_META.open;
  const statusText = isMergeable
    ? t('sessions.pr.mergeable', 'Mergeable')
    : t(statusMeta.labelKey, statusMeta.labelFallback);
  const numberLabel = prNumber !== null ? `#${prNumber}` : 'PR';

  const orderedMergeMethods = useMemo(
    () => [
      ...MERGE_METHOD_SPECS.filter((entry) => entry.method === preferredMergeMethod),
      ...MERGE_METHOD_SPECS.filter((entry) => entry.method !== preferredMergeMethod),
    ],
    [preferredMergeMethod]
  );

  const analyticsBase = useMemo(
    () => ({
      workspaceId: currentWorkspaceId ?? null,
      sessionId,
      repoFullName,
      prNumber: prNumber ?? 0,
    }),
    [currentWorkspaceId, prNumber, repoFullName, sessionId]
  );

  const handleMerge = useCallback(
    async (method: GitHubMergeMethod) => {
      setPreferredPrMergeMethod(method);
      const currentPr = details.data?.pullRequest ?? null;
      capturePrMergeRequested(postHog, analyticsBase, {
        mergeMethod: method,
        prStatus: resolvePrAnalyticsStatus(currentPr),
        ciStatus: resolveCiAnalyticsStatus(details.data?.checkRuns),
      });
      const startedAt = getPerformanceNowMs();
      try {
        await details.mergePullRequest(method);
        capturePrMergeSucceeded(postHog, analyticsBase, {
          mergeMethod: method,
          durationMs: getDurationSinceMs(startedAt),
        });
      } catch (err) {
        capturePrMergeFailed(postHog, analyticsBase, {
          mergeMethod: method,
          errorKind: classifyMergeError(err, currentPr),
          durationMs: getDurationSinceMs(startedAt),
        });
        if (isGitHubOperationTokenConnectionLostError(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        toast.error(t('sessions.prTab.mergeError', 'Failed to merge'), { description: message });
      }
    },
    [analyticsBase, details, postHog, t]
  );

  const handleSetState = useCallback(
    async (nextState: 'open' | 'closed') => {
      try {
        await details.setPullRequestState(nextState);
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
    [details, t]
  );

  const handleMarkReadyForReview = useCallback(async () => {
    try {
      await details.markReadyForReview();
    } catch (err) {
      let errorForToast: unknown = err;
      if (isRecoverableReadyForReviewAuthError(err)) {
        try {
          await details.refresh();
          await details.markReadyForReview();
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
  }, [details, t]);

  const handleDeleteBranch = useCallback(async () => {
    try {
      await details.deleteBranch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t('sessions.prTab.deleteBranchError', 'Failed to delete branch'), {
        description: message,
      });
    }
  }, [details, t]);

  const canResolveConflicts = Boolean(
    resolveConflictsAction?.available && !resolveConflictsAction.pending
  );
  const canClose = Boolean(
    details.canWrite && livePr && !livePr.merged && livePr.state !== 'closed'
  );
  const canReopen = Boolean(details.canWrite && livePr && mergeKind === 'closed');
  const canDeleteBranch = Boolean(
    details.canWrite &&
    livePr &&
    mergeKind === 'merged' &&
    details.branchExists === true &&
    livePr.headRef !== livePr.baseRef
  );
  const canMerge = Boolean(details.canWrite && livePr && mergeKind === 'ready' && !livePr.stack);
  const canMarkReady = Boolean(details.canWrite && livePr && mergeKind === 'draft');
  const blockedNotice =
    livePr && details.canWrite
      ? mergeKind === 'conflict'
        ? t('sessions.prTab.verdictConflict', 'Conflicts with the base branch')
        : mergeKind === 'blocked'
          ? t('sessions.prTab.verdictBlocked', 'Merging is blocked')
          : mergeKind === 'checking'
            ? t('sessions.prTab.mergeChecking', 'Checking if the branch can be merged…')
            : null
      : null;

  const isLoadingInitial =
    hasHostedGitHub &&
    Boolean(repoFullName && prNumber !== null) &&
    (details.state === 'idle' || details.state === 'loading') &&
    !livePr;
  const isErrorInitial =
    hasHostedGitHub &&
    Boolean(repoFullName && prNumber !== null) &&
    details.state === 'error' &&
    !livePr;

  const hasPrimarySection =
    isLoadingInitial ||
    isErrorInitial ||
    canMerge ||
    canMarkReady ||
    blockedNotice !== null ||
    canReopen ||
    canDeleteBranch ||
    canClose;

  return (
    <Menu.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setActivated(true);
        setOpen(nextOpen);
      }}
    >
      <Menu.Trigger
        render={
          <button
            type="button"
            title={`${numberLabel} · ${statusText}`}
            data-project-board-pr={prNumber ?? 'pr'}
            {...stylex.props(styles.prButton)}
          />
        }
      >
        {busy ? (
          <Spinner {...stylex.props(styles.spinner)} />
        ) : (
          <SessionPrIcon prStatus={effectiveStatus} prCiState={pr.ci} />
        )}
        <span>{numberLabel}</span>
        <span {...stylex.props(styles.prStatus, isMergeable && styles.prMergeable)}>
          {statusText}
        </span>
        <ChevronDown size={12} aria-hidden="true" {...stylex.props(styles.chevron)} />
      </Menu.Trigger>
      <Menu.Content align="end">
        {isLoadingInitial ? (
          <Menu.Item disabled icon={<Spinner {...stylex.props(styles.spinner)} />}>
            {t('sessions.prTab.checking', 'Checking…')}
          </Menu.Item>
        ) : null}

        {isErrorInitial ? (
          <Menu.Item icon={RotateCw} closeOnClick={false} onClick={() => void details.refresh()}>
            {t('sessions.prTab.retry', 'Retry')}
          </Menu.Item>
        ) : null}

        {canMerge
          ? orderedMergeMethods.map((entry) => (
              <Menu.Item
                key={entry.method}
                icon={GitMerge}
                disabled={busy}
                onClick={() => void handleMerge(entry.method)}
              >
                {t(entry.labelKey, entry.labelFallback)}
              </Menu.Item>
            ))
          : null}

        {canMarkReady ? (
          <Menu.Item
            icon={GitPullRequest}
            disabled={busy}
            onClick={() => void handleMarkReadyForReview()}
          >
            {t('sessions.prTab.readyForReview', 'Ready for review')}
          </Menu.Item>
        ) : null}

        {blockedNotice ? <Menu.GroupLabel>{blockedNotice}</Menu.GroupLabel> : null}

        {mergeKind === 'conflict' && canResolveConflicts ? (
          <Menu.Item icon={Wrench} disabled={busy} onClick={() => resolveConflictsAction?.run()}>
            {t('sessions.prTab.resolveConflicts', 'Resolve conflicts')}
          </Menu.Item>
        ) : null}

        {canReopen ? (
          <Menu.Item
            icon={GitPullRequestArrow}
            disabled={busy}
            onClick={() => void handleSetState('open')}
          >
            {t('sessions.prTab.reopenAction', 'Reopen pull request')}
          </Menu.Item>
        ) : null}

        {canDeleteBranch ? (
          <Menu.Item icon={Trash2} disabled={busy} onClick={() => void handleDeleteBranch()}>
            {t('sessions.prTab.deleteBranch', 'Delete branch')}
          </Menu.Item>
        ) : null}

        {canClose ? (
          <>
            {canMerge || canMarkReady || blockedNotice !== null ? <Menu.Separator /> : null}
            <Menu.Item
              tone="destructive"
              icon={GitPullRequestClosed}
              disabled={busy}
              onClick={() => void handleSetState('closed')}
            >
              {t('sessions.prTab.closeAction', 'Close pull request')}
            </Menu.Item>
          </>
        ) : null}

        {hasPrimarySection ? <Menu.Separator /> : null}

        {onOpenPr ? (
          <Menu.Item icon={GitPullRequest} onClick={() => onOpenPr(sessionId, pr)}>
            {prNumber !== null
              ? t('sessions.projectMembers.openPr', {
                  number: prNumber,
                  defaultValue: 'Open pull request #{{number}}',
                })
              : t('sessions.contextMenu.openPr', 'Open Pull Request')}
          </Menu.Item>
        ) : null}

        {livePr?.headRef ? (
          <Menu.Item icon={Copy} onClick={() => void writeTextToClipboard(livePr.headRef)}>
            {t('sessions.prTab.copyBranch', 'Copy branch name')}
          </Menu.Item>
        ) : null}

        <Menu.Item icon={ExternalLink} onClick={() => void openExternalUrl(pr.url)}>
          {t('sessions.prTab.openOnGitHub', 'Open on GitHub')}
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}
