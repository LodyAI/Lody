import {
  getSessionPullRequestLegacyFields,
  parseGitHubPrNumber,
  type SessionPullRequestMeta,
  type PrStatus,
} from '@lody/shared';
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

type PullRequestBadgeSize = 'sm' | 'md';

type StatusMeta = {
  icon: LucideIcon;
  className: string;
  /** Bare text-color token for a badge-less icon (e.g. the sidebar row status slot). */
  iconColorClassName: string;
  labelKey: string;
  labelFallback: string;
};

/** Shared per-status icon/color/label meta (also used by the info-bar ContextChip). */
export const PR_STATUS_META: Record<PrStatus, StatusMeta> = {
  open: {
    icon: GitPullRequest,
    className: 'bg-foreground/[0.06] text-github-open hover:bg-foreground/[0.1]',
    iconColorClassName: 'text-github-open',
    labelKey: 'sessions.pr.statusOpen',
    labelFallback: 'Open',
  },
  merged: {
    icon: GitMerge,
    className: 'bg-foreground/[0.06] text-pr-merged hover:bg-foreground/[0.1]',
    iconColorClassName: 'text-pr-merged',
    labelKey: 'sessions.pr.statusMerged',
    labelFallback: 'Merged',
  },
  closed: {
    icon: GitPullRequestClosed,
    className: 'bg-foreground/[0.06] text-github-closed hover:bg-foreground/[0.1]',
    iconColorClassName: 'text-github-closed',
    labelKey: 'sessions.pr.statusClosed',
    labelFallback: 'Closed',
  },
  draft: {
    icon: GitPullRequestDraft,
    className: 'bg-foreground/[0.06] text-github-draft hover:bg-foreground/[0.1]',
    iconColorClassName: 'text-github-draft',
    labelKey: 'sessions.pr.statusDraft',
    labelFallback: 'Draft',
  },
};

const SIZE_META: Record<PullRequestBadgeSize, { wrapper: string; icon: string }> = {
  sm: { wrapper: 'px-1.5 py-0.5 text-[11px]', icon: 'h-3 w-3' },
  md: { wrapper: 'px-2 py-1 text-xs', icon: 'h-3.5 w-3.5' },
};

type PullRequestBadgeProps = {
  pr: SessionPullRequestMeta;
  size?: PullRequestBadgeSize;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  /**
   * When provided, the badge renders as a button and calls this callback
   * instead of navigating to `pr.url`. Used to open the in-app PR tab.
   */
  onOpenTab?: () => void;
};

export const PullRequestBadge = ({
  pr,
  size = 'md',
  className,
  onClick,
  onOpenTab,
}: PullRequestBadgeProps) => {
  const { t } = useTranslation();
  const statusMeta = PR_STATUS_META[pr.status ?? 'open'] ?? PR_STATUS_META.open;
  const Icon = statusMeta.icon;
  const sizeMeta = SIZE_META[size];
  const legacy = getSessionPullRequestLegacyFields(pr);
  const prNumber =
    typeof legacy.number === 'number' && Number.isFinite(legacy.number)
      ? legacy.number
      : parseGitHubPrNumber(pr.url);
  const prLabel = prNumber ? `#${prNumber}` : 'PR';
  const statusLabel = t(statusMeta.labelKey, statusMeta.labelFallback);

  const sharedClassName = cn(
    'inline-flex items-center gap-1 rounded-md font-normal transition',
    sizeMeta.wrapper,
    statusMeta.className,
    'focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-primary/30',
    className
  );

  const content = (
    <>
      <Icon className={sizeMeta.icon} strokeWidth={2.25} />
      <span>{prLabel}</span>
    </>
  );

  if (onOpenTab) {
    return (
      <button
        type="button"
        className={sharedClassName}
        title={`${statusLabel} ${prLabel}`}
        onClick={onOpenTab}
      >
        {content}
      </button>
    );
  }

  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      className={sharedClassName}
      title={`${statusLabel} ${prLabel}`}
      onClick={onClick}
    >
      {content}
    </a>
  );
};
