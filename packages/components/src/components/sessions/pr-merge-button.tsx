import { ChevronDown, GitMerge } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import type { GitHubMergeMethod } from '@lody/shared';
import { Button, ButtonGroup } from '@lody/ui/button';
import { button as buttonTokens } from '@lody/ui/button/button.tokens.stylex';
import { Menu } from '@/ui/menu';
import { themeSpace } from '../../style/theme-scale.stylex';

const styles = stylex.create({
  fullMainGap: { [buttonTokens.gap]: 'calc(var(--spacing) * 1)' },
  fullTriggerPadding: { [buttonTokens.paddingXSmall]: 'calc(var(--spacing) * 1.5)' },
  compactMain: { gap: themeSpace[1], paddingInline: themeSpace[1.5] },
  compactTrigger: { paddingInline: 0 },
  icon: { width: themeSpace[3.5], height: themeSpace[3.5] },
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
  // A compact action is secondary in the info bar; a standalone ready action is primary.
  const buttonVariant = tone === 'ready' && !compact ? 'primary' : 'secondary';
  const mainContent = (
    <>
      {isMerging ? (
        <Spinner diameter="calc(var(--spacing) * 3.5)" />
      ) : (
        <GitMerge {...stylex.props(styles.icon)} />
      )}
      {isMerging ? t('sessions.prTab.merging', 'Merging…') : <PrMergeMethodLabel method={method} />}
    </>
  );

  return (
    <ButtonGroup data-pr-merge-control="">
      <Button
        type="button"
        size={compact ? 'mini' : 'small'}
        height={compact ? themeSpace[5] : themeSpace[8]}
        variant={buttonVariant}
        disabled={isDisabled}
        onClick={() => void onMerge?.(method)}
        xstyle={compact ? styles.compactMain : styles.fullMainGap}
      >
        {mainContent}
      </Button>
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button
              type="button"
              size={compact ? 'mini' : 'small'}
              height={compact ? themeSpace[5] : themeSpace[8]}
              width={compact ? themeSpace[5] : undefined}
              variant={buttonVariant}
              disabled={isMerging || !onSelectMethod}
              aria-label={t('sessions.prTab.chooseMergeMethod', 'Choose merge method')}
              xstyle={compact ? styles.compactTrigger : styles.fullTriggerPadding}
            >
              <ChevronDown {...stylex.props(styles.icon)} />
            </Button>
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
    </ButtonGroup>
  );
}
