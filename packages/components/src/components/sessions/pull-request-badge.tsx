import {
  getSessionPullRequestLegacyFields,
  parseGitHubPrNumber,
  type SessionPullRequestMeta,
  type PrStatus,
} from '@lody/shared';
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type React from 'react';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  themeDuration,
  themeEasing,
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

type PullRequestBadgeSize = 'sm' | 'md';

type StatusMeta = {
  icon: LucideIcon;
  className: string;
  /** Bare text-color token for a badge-less icon (e.g. the sidebar row status slot). */
  iconColorClassName: string;
  labelKey: string;
  labelFallback: string;
};

const styles = stylex.create({
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[1],
    borderRadius: themeRadius.md,
    fontWeight: themeFontWeight.normal,
    // The old Tailwind `focus:ring-*` painted nothing — the app forces
    // Tailwind's own ring transparent — but it still declared a `box-shadow`,
    // and a utility-layer shadow beats the base layer's inset focus ring. So
    // the badge showed NO focus indicator at all. Keep it that way.
    boxShadow: { default: null, ':focus-visible': 'none' },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  badgeSm: {
    paddingInline: themeSpace[1.5],
    paddingBlock: themeSpace[0.5],
    fontSize: '11px',
  },
  badgeMd: {
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[1],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
  },
  iconSm: { width: themeSpace[3], height: themeSpace[3] },
  iconMd: { width: themeSpace[3.5], height: themeSpace[3.5] },
});

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
  const legacy = getSessionPullRequestLegacyFields(pr);
  const prNumber =
    typeof legacy.number === 'number' && Number.isFinite(legacy.number)
      ? legacy.number
      : parseGitHubPrNumber(pr.url);
  const prLabel = prNumber ? `#${prNumber}` : 'PR';
  const statusLabel = t(statusMeta.labelKey, statusMeta.labelFallback);

  const badgeProps = stylex.props(styles.badge, size === 'sm' ? styles.badgeSm : styles.badgeMd);
  const iconProps = stylex.props(size === 'sm' ? styles.iconSm : styles.iconMd);

  const sharedClassName = clsx(badgeProps.className, statusMeta.className, className);

  const content = (
    <>
      <Icon {...iconProps} strokeWidth={2.25} />
      <span>{prLabel}</span>
    </>
  );

  if (onOpenTab) {
    return (
      <button
        type="button"
        {...badgeProps}
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
      {...badgeProps}
      className={sharedClassName}
      title={`${statusLabel} ${prLabel}`}
      onClick={onClick}
    >
      {content}
    </a>
  );
};
