import { withClassName } from '@/lib/stylex';
import { ChevronDown, GitMerge } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import type { GitHubMergeMethod } from '@lody/shared';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import { Menu } from '@/ui/menu';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  root: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'stretch',
    overflow: 'hidden',
    borderRadius: themeRadius.md,
  },
  /** The compact control paints its own tinted well behind both halves. */
  rootCompact: {
    height: themeSpace[5],
    backgroundColor: 'hsl(var(--status-success) / 0.08)',
  },
  compactMain: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[1],
    paddingInline: themeSpace[1.5],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    fontWeight: themeFontWeight.medium,
    color: themeColors.statusSuccess,
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
    ':focus-visible': { backgroundColor: 'hsl(var(--status-success) / 0.12)' },
    ':disabled': { opacity: 0.5 },
  },
  compactTrigger: {
    position: 'relative',
    display: 'flex',
    width: themeSpace[5],
    alignItems: 'center',
    justifyContent: 'center',
    color: themeColors.statusSuccess,
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
    '::before': {
      content: '""',
      position: 'absolute',
      left: 0,
      height: themeSpace[3],
      width: '1px',
      backgroundColor: 'hsl(var(--status-success) / 0.25)',
    },
    ':focus-visible': { backgroundColor: 'hsl(var(--status-success) / 0.12)' },
    ':disabled': { opacity: 0.5 },
  },
  icon: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
});

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
  // Dark themes brighten the green, where white text drops to ~2:1; use the
  // canvas color on it there, as the PR tab's merge button does.
  const greenClasses =
    'bg-status-success text-white hover:bg-status-success/90 dark:text-background';

  const mainContent = (
    <>
      {isMerging ? (
        <Spinner className="h-3.5 w-3.5" />
      ) : (
        <GitMerge {...stylex.props(styles.icon)} />
      )}
      {isMerging ? t('sessions.prTab.merging', 'Merging…') : <PrMergeMethodLabel method={method} />}
    </>
  );

  const rootProps = stylex.props(styles.root, compact && styles.rootCompact);

  return (
    <div {...rootProps} data-pr-merge-control="">
      {compact ? (
        <button
          type="button"
          disabled={isDisabled}
          onClick={() => void onMerge?.(method)}
          {...withClassName(
            stylex.props(styles.compactMain),
            'enabled:hover:bg-status-success/[0.10]'
          )}
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
                {...withClassName(
                  stylex.props(styles.compactTrigger),
                  'enabled:hover:bg-status-success/[0.10]'
                )}
              >
                <ChevronDown {...stylex.props(styles.icon)} />
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
                <ChevronDown {...stylex.props(styles.icon)} />
              </Button>
            )
          }
        />
        <Menu.Content align="end" side={compact ? 'top' : 'bottom'}>
          <Menu.RadioGroup
            value={method}
            onValueChange={(value) => onSelectMethod?.(value as GitHubMergeMethod)}
          >
            {MERGE_METHODS.map((candidate) => (
              <Menu.RadioItem key={candidate.value} value={candidate.value} indicator="check">
                {t(candidate.labelKey, candidate.labelFallback)}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Root>
    </div>
  );
}
