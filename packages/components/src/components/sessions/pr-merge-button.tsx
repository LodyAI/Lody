import { Check, ChevronDown, GitMerge } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import type { GitHubMergeMethod } from '@lody/shared';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import { Menu } from '@/ui/menu';

const MERGE_METHODS: Array<{
  value: GitHubMergeMethod;
  labelKey: string;
  labelFallback: string;
}> = [
  {
    value: 'merge',
    labelKey: 'sessions.prTab.mergeMerge',
    labelFallback: 'Create a merge commit',
  },
  {
    value: 'squash',
    labelKey: 'sessions.prTab.mergeSquash',
    labelFallback: 'Squash and merge',
  },
  {
    value: 'rebase',
    labelKey: 'sessions.prTab.mergeRebase',
    labelFallback: 'Rebase and merge',
  },
];

/**
 * The active merge method as a label. Exported because the info bar can demote
 * Merge into the overflow menu (a dirty worktree outranks it), and that plain
 * menu item has to name the same method the split button would have performed.
 */
export function PrMergeMethodLabel({ method }: { method: GitHubMergeMethod }) {
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
      {isMerging ? <Spinner className="h-3.5 w-3.5" /> : <GitMerge className="h-3.5 w-3.5" />}
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
          size="small"
          variant={buttonVariant}
          disabled={isDisabled}
          onClick={() => void onMerge?.(method)}
          className={cn(
            'h-8 gap-1 rounded-r-none',
            buttonVariant === 'secondary' ? 'border-r-0' : 'border-transparent',
            readyGreen && greenClasses
          )}
        >
          {mainContent}
        </Button>
      )}
      <Menu.Root>
        <Menu.Trigger
          render={
            compact ? (
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
                size="small"
                variant={buttonVariant}
                disabled={isMerging || !onSelectMethod}
                aria-label={t('sessions.prTab.chooseMergeMethod', 'Choose merge method')}
                className={cn(
                  'h-8 rounded-l-none border-l border-black/10 px-1.5',
                  readyGreen && cn(greenClasses, 'border-l-white/25')
                )}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            )
          }
        />
        <Menu.Content align="end" side={compact ? 'top' : 'bottom'}>
          {MERGE_METHODS.map((candidate) => {
            const isActive = candidate.value === method;
            return (
              <Menu.Item
                key={candidate.value}
                onClick={() => onSelectMethod?.(candidate.value)}
              >
                <Check
                  className={cn('shrink-0', isActive ? 'text-foreground' : 'text-transparent')}
                />
                {t(candidate.labelKey, candidate.labelFallback)}
              </Menu.Item>
            );
          })}
        </Menu.Content>
      </Menu.Root>
    </div>
  );
}
