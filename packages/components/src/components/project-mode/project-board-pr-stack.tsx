import * as stylex from '@stylexjs/stylex';
import { Popover } from '@lody/ui/popover';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import type { SessionPullRequestView } from '@lody/shared';
import { AlertTriangle, CheckCircle2, Clock, GitMerge } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SessionPrIcon } from '@/components/sidebar-row-shared';
import {
  hasMultiplePullRequestRepos,
  resolveOwnerSessionForPullRequest,
  summarizeProjectBoardPullRequests,
  type ProjectBoardRow,
} from './project-board-model';
import { ProjectBoardPrMenu } from './project-board-pr-menu';

const MAX_STACKED_PR_AVATARS = 4;

const SUCCESS_SOFT = `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.success} 16%)`;
const WARNING_SOFT = `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.warning} 18%)`;
const DESTRUCTIVE_SOFT = `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.destructive} 16%)`;
const ACCENT_SOFT = `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.accent} 14%)`;

const styles = stylex.create({
  clusterTrigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    maxWidth: '100%',
    minWidth: 0,
    paddingBlock: 2,
    paddingInlineStart: 3,
    paddingInlineEnd: space[2],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: radius.full,
    backgroundColor: { default: colors.elevatedBackground, ':hover': colors.hoverFill },
    color: colors.label,
    cursor: 'pointer',
    flexShrink: 0,
    transitionProperty: 'background-color, border-color',
    transitionDuration: '120ms',
  },
  avatarStack: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  avatarCircle: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    borderRadius: radius.full,
    borderWidth: 2,
    borderStyle: 'solid',
    borderColor: colors.elevatedBackground,
    backgroundColor: colors.wellBackground,
    flexShrink: 0,
    transitionProperty: 'transform',
    transitionDuration: '120ms',
  },
  avatarOverlap: {
    marginInlineStart: -9,
  },
  avatarSuccess: {
    backgroundColor: SUCCESS_SOFT,
  },
  avatarWarning: {
    backgroundColor: WARNING_SOFT,
  },
  avatarDanger: {
    backgroundColor: DESTRUCTIVE_SOFT,
  },
  avatarAccent: {
    backgroundColor: ACCENT_SOFT,
  },
  avatarOverflow: {
    fontSize: 10,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryLabel,
    backgroundColor: colors.trayBackground,
  },
  clusterSummary: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryLabel,
  },
  summarySuccess: {
    color: colors.success,
    fontWeight: 500,
  },
  summaryDanger: {
    color: colors.destructive,
    fontWeight: 500,
  },
  summaryWarning: {
    color: colors.warning,
    fontWeight: 500,
  },
  popoverBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
    minWidth: 260,
    maxWidth: 360,
    padding: space[2],
  },
  popoverHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    paddingInline: space[1],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 600,
    color: colors.secondaryLabel,
  },
  popoverRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    paddingBlock: space[1],
    paddingInline: space[1.5],
    borderRadius: radius.medium,
    backgroundColor: colors.wellBackground,
  },
  popoverCiChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.secondaryLabel,
    flexShrink: 0,
  },
  ciPass: { color: colors.success },
  ciFail: { color: colors.destructive },
  ciPending: { color: colors.warning },
});

function resolvePrAvatarTone(
  pr: SessionPullRequestView
): 'success' | 'danger' | 'warning' | 'accent' | 'default' {
  if (pr.state?.m === 'd' || pr.state?.s === 'f' || pr.state?.s === 'e') return 'danger';
  if (pr.state?.s === 'p') return 'warning';
  if (pr.status === 'merged' || pr.readiness === 'y') return 'success';
  if (pr.status === 'open') return 'accent';
  return 'default';
}

function formatPrTooltip(pr: SessionPullRequestView): string {
  const repo = pr.repoFullName?.trim() || '';
  const num = pr.number !== null ? `#${pr.number}` : 'PR';
  const ci =
    pr.state?.s === 's'
      ? ' · CI:pass'
      : pr.state?.s === 'f' || pr.state?.s === 'e'
        ? ' · CI:fail'
        : pr.state?.s === 'p'
          ? ' · CI:pending'
          : '';
  const conflict = pr.state?.m === 'd' ? ' · conflict' : '';
  return `${repo ? `${repo} ` : ''}${num} (${pr.status}${ci}${conflict})`;
}

function PrCiStatusChip({ pr }: { pr: SessionPullRequestView }) {
  const { t } = useTranslation();
  if (pr.status === 'merged') {
    return (
      <span {...stylex.props(styles.popoverCiChip, styles.ciPass)}>
        <GitMerge size={11} aria-hidden="true" />
        {t('projectMode.board.prMergedShort', 'Merged')}
      </span>
    );
  }
  if (pr.state?.m === 'd') {
    return (
      <span {...stylex.props(styles.popoverCiChip, styles.ciFail)}>
        <AlertTriangle size={11} aria-hidden="true" />
        {t('projectMode.board.prConflictShort', 'Conflict')}
      </span>
    );
  }
  if (pr.state?.s === 'f' || pr.state?.s === 'e') {
    return (
      <span {...stylex.props(styles.popoverCiChip, styles.ciFail)}>
        <AlertTriangle size={11} aria-hidden="true" />
        {t('projectMode.board.ciFailShort', 'CI failed')}
      </span>
    );
  }
  if (pr.state?.s === 'p') {
    return (
      <span {...stylex.props(styles.popoverCiChip, styles.ciPending)}>
        <Clock size={11} aria-hidden="true" />
        {t('projectMode.board.ciPendingShort', 'CI running')}
      </span>
    );
  }
  if (pr.state?.s === 's') {
    return (
      <span {...stylex.props(styles.popoverCiChip, styles.ciPass)}>
        <CheckCircle2 size={11} aria-hidden="true" />
        {t('projectMode.board.ciPassShort', 'CI passed')}
      </span>
    );
  }
  return null;
}

/**
 * Overlapping avatar-style PR stack for task cards.
 * Keeps multi-PR / multi-repo tasks compact on the card face while opening a
 * full per-PR status & merge menu popover on click.
 */
export function ProjectBoardPrStack({
  row,
  onOpenPr,
}: {
  row: Pick<ProjectBoardRow, 'session' | 'members' | 'pullRequests'>;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
}) {
  const { t } = useTranslation();
  const { pullRequests } = row;
  if (pullRequests.length === 0) return null;

  if (pullRequests.length === 1) {
    const pr = pullRequests[0]!;
    return (
      <ProjectBoardPrMenu
        sessionId={resolveOwnerSessionForPullRequest(row, pr.url)}
        pr={pr}
        showRepoPrefix={false}
        onOpenPr={onOpenPr}
      />
    );
  }

  const visiblePrs = pullRequests.slice(0, MAX_STACKED_PR_AVATARS);
  const overflowCount = pullRequests.length - visiblePrs.length;
  const summary = summarizeProjectBoardPullRequests(pullRequests);
  const showRepo = hasMultiplePullRequestRepos(pullRequests);

  const summaryTone =
    summary.failingCi > 0 || summary.conflicts > 0
      ? 'danger'
      : summary.pendingCi > 0
        ? 'warning'
        : summary.mergeable === summary.total || summary.merged === summary.total
          ? 'success'
          : 'default';

  const summaryText =
    summary.conflicts > 0
      ? t('projectMode.board.prClusterConflicts', '{{count}} PR · {{issues}} conflict', {
          count: summary.total,
          issues: summary.conflicts,
        })
      : summary.failingCi > 0
        ? t('projectMode.board.prClusterCiFail', '{{count}} PR · {{issues}} CI failed', {
            count: summary.total,
            issues: summary.failingCi,
          })
        : summary.pendingCi > 0
          ? t('projectMode.board.prClusterCiPending', '{{count}} PR · CI running', {
              count: summary.total,
            })
          : summary.merged === summary.total
            ? t('projectMode.board.prClusterMerged', '{{count}} PR · Merged', {
                count: summary.total,
              })
            : summary.mergeable === summary.total
              ? t('projectMode.board.prClusterAllMergeable', '{{count}} PR · All mergeable', {
                  count: summary.total,
                })
              : summary.mergeable > 0
                ? t('projectMode.board.prClusterMergeable', '{{count}} PR · {{ready}} ready', {
                    count: summary.total,
                    ready: summary.mergeable,
                  })
                : t('projectMode.board.prClusterCount', '{{count}} PR', {
                    count: summary.total,
                  });

  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <button
            type="button"
            data-project-board-pr-stack=""
            title={pullRequests.map(formatPrTooltip).join('\n')}
            onClick={(event) => event.stopPropagation()}
            {...stylex.props(styles.clusterTrigger)}
          >
            <span {...stylex.props(styles.avatarStack)} aria-hidden="true">
              {visiblePrs.map((pr, index) => {
                const tone = resolvePrAvatarTone(pr);
                return (
                  <span
                    key={pr.url}
                    style={{ zIndex: visiblePrs.length - index }}
                    {...stylex.props(
                      styles.avatarCircle,
                      index > 0 && styles.avatarOverlap,
                      tone === 'success' && styles.avatarSuccess,
                      tone === 'warning' && styles.avatarWarning,
                      tone === 'danger' && styles.avatarDanger,
                      tone === 'accent' && styles.avatarAccent
                    )}
                  >
                    <SessionPrIcon prStatus={pr.status} prCiState={pr.state?.s} compact />
                  </span>
                );
              })}
              {overflowCount > 0 ? (
                <span
                  style={{ zIndex: 0 }}
                  {...stylex.props(
                    styles.avatarCircle,
                    styles.avatarOverlap,
                    styles.avatarOverflow
                  )}
                >
                  +{overflowCount}
                </span>
              ) : null}
            </span>
            <span
              {...stylex.props(
                styles.clusterSummary,
                summaryTone === 'success' && styles.summarySuccess,
                summaryTone === 'danger' && styles.summaryDanger,
                summaryTone === 'warning' && styles.summaryWarning
              )}
            >
              {summaryText}
            </span>
          </button>
        }
      />
      <Popover.Content side="bottom" align="end" padding="none" gap="none">
        <div {...stylex.props(styles.popoverBody)} onClick={(event) => event.stopPropagation()}>
          <div {...stylex.props(styles.popoverHeader)}>
            <span>
              {t('projectMode.board.prClusterTitle', 'Linked pull requests ({{count}})', {
                count: pullRequests.length,
              })}
            </span>
          </div>
          {pullRequests.map((pr) => (
            <div key={pr.url} {...stylex.props(styles.popoverRow)}>
              <ProjectBoardPrMenu
                sessionId={resolveOwnerSessionForPullRequest(row, pr.url)}
                pr={pr}
                showRepoPrefix={showRepo}
                onOpenPr={onOpenPr}
              />
              <PrCiStatusChip pr={pr} />
            </div>
          ))}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
