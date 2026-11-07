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
  iconXstyle: stylex.StyleXStyles;
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
    backgroundColor: {
      default: 'color-mix(in oklab, hsl(var(--foreground) / 1) 6%, transparent)',
      '@media (hover: hover)': {
        ':hover': 'color-mix(in oklab, hsl(var(--foreground) / 1) 10%, transparent)',
      },
    },
    // The old Tailwind `focus:ring-*` painted nothing — the app forces
    // Tailwind's own ring transparent — but it still declared a `box-shadow`,
    // and a utility-layer shadow beats the base layer's inset focus ring. So
    // the badge showed NO focus indicator at all. Keep it that way.
    boxShadow: { default: null, ':focus-visible': 'none' },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
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
  open: { color: 'hsl(var(--github-open) / 1)' },
  merged: { color: 'hsl(var(--github-merged))' },
  closed: { color: 'hsl(var(--github-closed) / 1)' },
  draft: { color: 'hsl(var(--github-draft) / 1)' },
});

/** Shared per-status icon/color/label meta (also used by the info-bar ContextChip). */
export const PR_STATUS_META: Record<PrStatus, StatusMeta> = {
  open: {
    icon: GitPullRequest,
    iconXstyle: styles.open,
    labelKey: 'sessions.pr.statusOpen',
    labelFallback: 'Open',
  },
  merged: {
    icon: GitMerge,
    iconXstyle: styles.merged,
    labelKey: 'sessions.pr.statusMerged',
    labelFallback: 'Merged',
  },
  closed: {
    icon: GitPullRequestClosed,
    iconXstyle: styles.closed,
    labelKey: 'sessions.pr.statusClosed',
    labelFallback: 'Closed',
  },
  draft: {
    icon: GitPullRequestDraft,
    iconXstyle: styles.draft,
    labelKey: 'sessions.pr.statusDraft',
    labelFallback: 'Draft',
  },
};

type PullRequestBadgeProps = {
  pr: SessionPullRequestMeta;
  size?: PullRequestBadgeSize;
  className?: string;
  xstyle?: stylex.StyleXStyles;
  iconXstyle?: stylex.StyleXStyles;
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
  xstyle,
  iconXstyle,
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

  const badgeProps = stylex.props(
    styles.badge,
    size === 'sm' ? styles.badgeSm : styles.badgeMd,
    statusMeta.iconXstyle,
    xstyle
  );
  const iconProps = stylex.props(size === 'sm' ? styles.iconSm : styles.iconMd, iconXstyle);

  const sharedClassName = clsx(badgeProps.className, className);

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
