import type { ElementType, ReactNode } from 'react';
import { ArrowUpRight, GitBranchPlus } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

import { withClassName } from '@/lib/stylex';

const styles = stylex.create({
  root: { minWidth: 0 },
  action: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    minWidth: 0,
    height: '32px',
    gap: space[2],
    paddingInline: '10px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: `color-mix(in oklab, ${colors.separator} 60%, transparent)`,
    borderRadius: '6px',
    backgroundColor: {
      default: 'color-mix(in oklab, hsl(var(--muted)) 20%, transparent)',
      ':hover': 'color-mix(in oklab, hsl(var(--muted)) 50%, transparent)',
      ':disabled:hover': 'color-mix(in oklab, hsl(var(--muted)) 20%, transparent)',
    },
    textAlign: 'left',
    fontSize: '12px',
    lineHeight: '16px',
    color: colors.secondaryLabel,
    transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    cursor: { default: 'pointer', ':disabled': 'default' },
  },
  icon: { width: '14px', height: '14px', flexShrink: 0 },
  label: { flexShrink: 0 },
  title: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 500,
    color: colors.label,
  },
  detail: {
    minWidth: 0,
    flexGrow: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  end: { display: 'flex', alignItems: 'center', flexShrink: 0, gap: space[2], marginLeft: 'auto' },
  actionIcon: {
    width: '14px',
    height: '14px',
    opacity: {
      default: 0.6,
      ':is([data-session-relation-action]:hover *)': 1,
    },
    transitionProperty: 'opacity',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
});

export function SessionRelationCard({
  label,
  sessionTitle,
  actionLabel,
  onAction,
  icon: Icon = GitBranchPlus,
  actionIcon: ActionIcon = ArrowUpRight,
  className,
  relation,
  status,
  detail,
}: {
  label: string;
  sessionTitle: string;
  actionLabel: string;
  onAction?: () => void;
  icon?: ElementType<{ className?: string }>;
  actionIcon?: ElementType<{ className?: string }>;
  className?: string;
  relation: 'opened' | 'opened-by';
  status?: ReactNode;
  /** Optional one-glance context under the title (a reply preview, an error). */
  detail?: ReactNode;
}) {
  // One line: the info bar's related-Sessions chip is the persistent index,
  // so the in-stream record only needs what happened, to whom, and a way there.
  return (
    <div data-session-relation-card={relation} {...withClassName(stylex.props(styles.root), className)}>
      <button
        type="button"
        data-session-relation-action
        disabled={!onAction}
        onClick={onAction}
        title={sessionTitle}
        aria-label={`${actionLabel}: ${sessionTitle}`}
        {...stylex.props(styles.action)}
      >
        <Icon {...stylex.props(styles.icon)} aria-hidden="true" />
        <span {...stylex.props(styles.label)}>{label}</span>
        <span {...stylex.props(styles.title)}>{sessionTitle}</span>
        {detail ? <span {...stylex.props(styles.detail)}>· {detail}</span> : null}
        <span {...stylex.props(styles.end)}>
          {status}
          {onAction ? (
            <ActionIcon {...stylex.props(styles.actionIcon)} aria-hidden="true" />
          ) : null}
        </span>
      </button>
    </div>
  );
}
