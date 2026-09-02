import type { ElementType } from 'react';
import { ArrowUpRight, GitBranchPlus } from 'lucide-react';

import { Button } from '@lody/ui/button';
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
}: {
  label: string;
  sessionTitle: string;
  actionLabel: string;
  onAction?: () => void;
  icon?: ElementType<{ className?: string }>;
  actionIcon?: ElementType<{ className?: string }>;
  className?: string;
  relation: 'opened' | 'opened-by';
}) {
  return (
    <div
      data-session-relation-card={relation}
      className={cn(
        'flex min-w-0 flex-col items-stretch gap-2.5 rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3',
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-xs leading-4 text-muted-foreground">{label}</div>
          <div className="truncate text-sm font-medium text-foreground" title={sessionTitle}>
            {sessionTitle}
          </div>
        </div>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="small"
        className="shrink-0 self-end sm:self-auto"
        disabled={!onAction}
        onClick={onAction}
      >
        {actionLabel}
        <ActionIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}
