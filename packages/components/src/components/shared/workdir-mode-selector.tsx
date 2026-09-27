import { Check, ChevronDown, Folder, GitBranch } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

import { withClassName } from '@/lib/stylex';
import { Button } from '@lody/ui/button';
import { Menu } from '@/ui/menu';
import { Tooltip } from '@lody/ui/tooltip';
import { Checkbox } from '@lody/ui/checkbox';

const styles = stylex.create({
  checkboxPill: {
    display: 'flex',
    alignItems: 'center',
    height: '24px',
    flexShrink: 0,
    gap: space[1.5],
    paddingInline: space[2],
    borderRadius: '6px',
    backgroundColor: {
      default: 'hsl(var(--hover))',
      ':hover': 'color-mix(in oklab, hsl(var(--hover)) 80%, transparent)',
    },
    fontSize: '12px',
    lineHeight: '16px',
    fontWeight: 400,
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    userSelect: 'none',
    cursor: 'pointer',
    transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  checkboxPillDisabled: {
    cursor: 'not-allowed',
    backgroundColor: { default: 'hsl(var(--hover))', ':hover': 'hsl(var(--hover))' },
    color: { default: colors.secondaryLabel, ':hover': colors.secondaryLabel },
  },
  checkboxPillContext: {
    borderRadius: 0,
    backgroundColor: {
      default: 'transparent',
      ':hover': `color-mix(in oklab, ${colors.label} 6%, transparent)`,
    },
    color: {
      default: `color-mix(in oklab, ${colors.label} 80%, transparent)`,
      ':hover': colors.label,
    },
  },
  checkboxPillContextDisabled: {
    color: {
      default: `color-mix(in oklab, ${colors.label} 80%, transparent)`,
      ':hover': `color-mix(in oklab, ${colors.label} 80%, transparent)`,
    },
  },
  tooltipTrigger: { display: 'inline-flex' },
  tooltipCopy: { maxWidth: '288px' },
  readOnlyTrigger: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '28px',
    gap: space[1.5],
    paddingInline: '10px',
    borderRadius: '8px',
    fontSize: '13px',
    lineHeight: 1,
    fontWeight: 500,
    letterSpacing: '-0.01em',
    color: colors.secondaryLabel,
    opacity: 0.8,
    whiteSpace: 'nowrap',
    userSelect: 'none',
  },
  selectedIcon: { width: '14px', height: '14px', flexShrink: 0 },
  selectedLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '12px',
    lineHeight: 1.25,
    fontWeight: 500,
  },
  chevron: { width: '14px', height: '14px', flexShrink: 0, opacity: 0.7 },
  optionRow: { display: 'flex', minWidth: 0, alignItems: 'center', gap: space[2] },
  optionIcon: { width: '14px', height: '14px', flexShrink: 0, opacity: 0.8 },
  optionLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  checkIcon: { width: '12px', height: '12px', opacity: 0.7 },
});

export type WorkdirMode = 'local' | 'worktree';

export interface WorkdirModeSelectorProps {
  tone: 'light' | 'dark';
  mode: WorkdirMode;
  onModeChange?: (next: WorkdirMode) => void;
  worktreeAvailable: boolean;
  worktreeUnavailableReason?: string;
  /**
   * Radix DropdownMenu modality (default true). The landing-page demo passes
   * false so the open menu doesn't scroll-lock the page it's embedded in.
   */
  modal?: boolean;
}

export interface WorktreeCheckboxPillProps {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
  /** Flat composer-context presentation; the default is the standalone pill. */
  surface?: 'default' | 'context';
  className?: string;
}

export function WorktreeCheckboxPill({
  checked,
  onCheckedChange,
  disabled = false,
  disabledReason,
  surface = 'default',
  className,
}: WorktreeCheckboxPillProps) {
  const { t } = useTranslation();
  const control = (
    <label
      {...withClassName(
        stylex.props(
          styles.checkboxPill,
          disabled && styles.checkboxPillDisabled,
          surface === 'context' && styles.checkboxPillContext,
          surface === 'context' && disabled && styles.checkboxPillContextDisabled
        ),
        className
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onCheckedChange?.(next)}
        disabled={disabled}
        aria-label={t('chat.workdir.worktreeToggle', 'Use worktree')}
      />
      <span>{t('chat.workdir.worktreePill', 'worktree')}</span>
    </label>
  );

  if (!disabledReason) return control;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger delay={400} render={<span {...stylex.props(styles.tooltipTrigger)}>{control}</span>} />
      <Tooltip.Content side="top">
        <span {...stylex.props(styles.tooltipCopy)}>{disabledReason}</span>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

const modeIcon = {
  local: Folder,
  worktree: GitBranch,
} as const;

export function WorkdirModeSelector({
  mode,
  onModeChange,
  worktreeAvailable,
  worktreeUnavailableReason,
  modal,
}: WorkdirModeSelectorProps) {
  const { t } = useTranslation();
  const readOnly = !onModeChange;
  const selectedMode = mode === 'worktree' && worktreeAvailable ? 'worktree' : 'local';
  const SelectedIcon = modeIcon[selectedMode];
  const options: Array<{
    value: WorkdirMode;
    label: string;
    description?: string;
    disabled?: boolean;
  }> = [
    {
      value: 'local',
      label: t('chat.workdir.local', 'Local'),
      description: t('chat.workdir.localDescription', 'Use the original local project folder.'),
    },
    {
      value: 'worktree',
      label: t('chat.workdir.worktree', 'Worktree'),
      description:
        worktreeUnavailableReason ??
        t('chat.workdir.worktreeDescription', 'Create an isolated git worktree for this session.'),
      disabled: !worktreeAvailable,
    },
  ];
  const selectedOption = options.find((option) => option.value === selectedMode) ?? options[0]!;

  const triggerContent = (
    <>
      <SelectedIcon {...stylex.props(styles.selectedIcon)} />
      <span {...stylex.props(styles.selectedLabel)}>{selectedOption.label}</span>
      {!readOnly ? <ChevronDown {...stylex.props(styles.chevron)} /> : null}
    </>
  );

  if (readOnly) {
    return (
      <Tooltip.Root>
        <Tooltip.Trigger
          delay={500}
          render={
            <span {...stylex.props(styles.tooltipTrigger)}>
              <span
                {...stylex.props(styles.readOnlyTrigger)}
                aria-label={t('chat.workdir.selectorLabel', 'Working directory mode')}
              >
                {triggerContent}
              </span>
            </span>
          }
        />
        <Tooltip.Content side="top">
          {t('chat.workdir.readOnly', 'Working directory mode cannot be changed after creation.')}
        </Tooltip.Content>
      </Tooltip.Root>
    );
  }

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="small"
      aria-label={t('chat.workdir.selectorLabel', 'Working directory mode')}
    >
      {triggerContent}
    </Button>
  );

  return (
    <Menu.Root modal={modal}>
      <Menu.Trigger render={trigger}>{trigger}</Menu.Trigger>
      <Menu.Content align="end" width="compact">
        {options.map((option) => {
          const Icon = modeIcon[option.value];
          const item = (
            <Menu.Item
              key={option.value}
              disabled={option.disabled}
              onClick={() => onModeChange(option.value)}
            >
              <span {...stylex.props(styles.optionRow)}>
                <Icon {...stylex.props(styles.optionIcon)} />
                <span {...stylex.props(styles.optionLabel)}>{option.label}</span>
              </span>
              {option.value === selectedMode ? <Check {...stylex.props(styles.checkIcon)} /> : null}
            </Menu.Item>
          );

          if (option.description) {
            return (
              <Tooltip.Root key={option.value}>
                <Tooltip.Trigger delay={500} render={item}/>
                <Tooltip.Content side="left">{option.description}</Tooltip.Content>
              </Tooltip.Root>
            );
          }
          return item;
        })}
      </Menu.Content>
    </Menu.Root>
  );
}
