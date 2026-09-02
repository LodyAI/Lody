import { Check, ChevronDown, GitMerge, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GitHubMergeMethod } from '@lody/shared';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

const MERGE_METHODS: Array<{
  value: GitHubMergeMethod;
  labelKey: string;
  labelFallback: string;
  descKey: string;
  descFallback: string;
}> = [
  {
    value: 'merge',
    labelKey: 'sessions.prTab.mergeMerge',
    labelFallback: 'Create a merge commit',
    descKey: 'sessions.prTab.mergeMergeDesc',
    descFallback: 'All commits from this branch will be added to the base branch.',
  },
  {
    value: 'squash',
    labelKey: 'sessions.prTab.mergeSquash',
    labelFallback: 'Squash and merge',
    descKey: 'sessions.prTab.mergeSquashDesc',
    descFallback: 'The commits from this branch will be combined into a single commit.',
  },
  {
    value: 'rebase',
    labelKey: 'sessions.prTab.mergeRebase',
    labelFallback: 'Rebase and merge',
    descKey: 'sessions.prTab.mergeRebaseDesc',
    descFallback: 'The commits will be rebased and added to the base branch.',
  },
];

function PrMergeMethodLabel({ method }: { method: GitHubMergeMethod }) {
  const { t } = useTranslation();
  if (method === 'squash') {
    return <>{t('sessions.prTab.mergeSquashAction', 'Squash and merge')}</>;
  }
  if (method === 'rebase') {
    return <>{t('sessions.prTab.mergeRebaseAction', 'Rebase and merge')}</>;
  }
  return <>{t('sessions.prTab.mergeAction', 'Merge pull request')}</>;
}

export function PrMergeButton({
  method,
  isMerging = false,
  disabled = false,
  compact = false,
  tone = 'ready',
  onMerge,
  onSelectMethod,
}: {
  method: GitHubMergeMethod;
  isMerging?: boolean;
  disabled?: boolean;
  compact?: boolean;
  tone?: 'ready' | 'conflict' | 'neutral';
  onMerge?: (method: GitHubMergeMethod) => void | Promise<void>;
  onSelectMethod?: (method: GitHubMergeMethod) => void;
}) {
  const { t } = useTranslation();
  const isDisabled = disabled || isMerging || !onMerge;
  const buttonVariant =
    tone === 'ready' ? 'primary' : tone === 'conflict' ? 'destructive' : 'secondary';
  // The full (non-compact) ready button uses GitHub's green so "merge" reads as
  // the positive terminal action, matching the compact info-bar merge control.
  const readyGreen = tone === 'ready' && !compact;
  const greenClasses = 'bg-status-success text-white hover:bg-status-success/90';

  const mainContent = (
    <>
      {isMerging ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <GitMerge className="h-3.5 w-3.5" />
      )}
      {isMerging ? t('sessions.prTab.merging', 'Merging…') : <PrMergeMethodLabel method={method} />}
    </>
  );

  return (
    <div
      className={cn(
        'flex shrink-0 items-stretch overflow-hidden rounded-md',
        compact && 'h-6 border border-status-success/35 bg-status-success/[0.08]'
      )}
      data-pr-merge-control=""
    >
      {compact ? (
        <button
          type="button"
          disabled={isDisabled}
          onClick={() => void onMerge?.(method)}
          className="flex min-w-0 items-center gap-1 px-1.5 text-xs font-medium text-status-success outline-none transition-colors enabled:hover:bg-status-success/[0.10] focus-visible:bg-status-success/[0.12] disabled:opacity-50"
        >
          {mainContent}
        </button>
      ) : (
        <Button
          type="button"
          variant={buttonVariant}
          size="small"
          disabled={isDisabled}
          onClick={() => void onMerge?.(method)}
          className={cn(readyGreen && greenClasses)}
        >
          {mainContent}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {compact ? (
            <button
              type="button"
              disabled={isMerging || !onSelectMethod}
              aria-label={t('sessions.prTab.chooseMergeMethod', 'Choose merge method')}
              className="relative flex w-5 items-center justify-center border-l border-status-success/20 text-status-success outline-none transition-colors enabled:hover:bg-status-success/[0.10] focus-visible:bg-status-success/[0.12] disabled:opacity-50"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          ) : (
            <Button
              type="button"
              variant={buttonVariant}
              size="small"
              disabled={isMerging || !onSelectMethod}
              aria-label={t('sessions.prTab.chooseMergeMethod', 'Choose merge method')}
              className={cn(readyGreen && greenClasses)}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side={compact ? 'top' : 'bottom'}
          className="min-w-[280px]"
        >
          {MERGE_METHODS.map((candidate) => {
            const isActive = candidate.value === method;
            return (
              <DropdownMenuItem
                key={candidate.value}
                onClick={() => onSelectMethod?.(candidate.value)}
                className="items-start"
              >
                <Check
                  className={cn(
                    'mt-0.5 h-3.5 w-3.5 shrink-0',
                    isActive ? 'text-foreground' : 'text-transparent'
                  )}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    {t(candidate.labelKey, candidate.labelFallback)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {t(candidate.descKey, candidate.descFallback)}
                  </span>
                </div>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
