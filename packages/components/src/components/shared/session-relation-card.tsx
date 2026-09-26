import type { ElementType, ReactNode } from 'react';
import { ArrowUpRight, GitBranchPlus } from 'lucide-react';

import { cn } from '@/lib/utils';

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
    <div data-session-relation-card={relation} className={cn('min-w-0', className)}>
      <button
        type="button"
        disabled={!onAction}
        onClick={onAction}
        title={sessionTitle}
        aria-label={`${actionLabel}: ${sessionTitle}`}
        className="group flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-muted/20"
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="shrink-0">{label}</span>
        <span className="min-w-0 truncate font-medium text-foreground">{sessionTitle}</span>
        {detail ? <span className="min-w-0 flex-1 truncate">· {detail}</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {status}
          {onAction ? (
            <ActionIcon
              className="h-3.5 w-3.5 opacity-60 transition-opacity group-hover:opacity-100"
              aria-hidden="true"
            />
          ) : null}
        </span>
      </button>
    </div>
  );
}
