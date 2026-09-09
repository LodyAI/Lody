import { Check, ChevronDown, Folder, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { Checkbox } from '@/ui/checkbox';

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
  className?: string;
}

export function WorktreeCheckboxPill({
  checked,
  onCheckedChange,
  disabled = false,
  disabledReason,
  className,
}: WorktreeCheckboxPillProps) {
  const { t } = useTranslation();
  const control = (
    <label
      className={cn(
        'flex h-6 shrink-0 select-none items-center gap-1.5 rounded-md bg-hover px-2 text-xs font-normal',
        'text-muted-foreground transition-colors',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-hover/80 hover:text-foreground',
        className
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onCheckedChange?.(next === true)}
        disabled={disabled}
        aria-label={t('chat.workdir.worktreeToggle', 'Use worktree')}
        className={cn(
          'size-3 rounded-[3px] border-transparent bg-muted-foreground/15 shadow-none [&_svg]:size-3',
          'data-[state=checked]:border-transparent data-[state=checked]:bg-muted-foreground/25 data-[state=checked]:text-foreground/80',
          'dark:bg-muted-foreground/15 dark:data-[state=checked]:bg-muted-foreground/25',
          'disabled:cursor-not-allowed disabled:opacity-100'
        )}
      />
      <span>{t('chat.workdir.worktreePill', 'worktree')}</span>
    </label>
  );

  if (!disabledReason) return control;

  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <span className="inline-flex">{control}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        {disabledReason}
      </TooltipContent>
    </Tooltip>
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

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="small"
      disabled={readOnly}
      aria-label={t('chat.workdir.selectorLabel', 'Working directory mode')}
      className={cn(
        'min-w-0 shrink select-none',
        'focus-visible:ring-0 focus-visible:ring-offset-0',
        readOnly && 'cursor-default opacity-80'
      )}
    >
      <SelectedIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate text-xs font-medium leading-tight">{selectedOption.label}</span>
      {!readOnly ? <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" /> : null}
    </Button>
  );

  if (readOnly) {
    return (
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <span className="inline-flex">{trigger}</span>
        </TooltipTrigger>
        <TooltipContent side="top">
          {t('chat.workdir.readOnly', 'Working directory mode cannot be changed after creation.')}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <DropdownMenu modal={modal}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        {options.map((option) => {
          const Icon = modeIcon[option.value];
          const item = (
            <DropdownMenuItem
              key={option.value}
              disabled={option.disabled}
              onSelect={() => onModeChange(option.value)}
              className="justify-between"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon className="h-3.5 w-3.5 shrink-0 opacity-80" />
                <span className="truncate">{option.label}</span>
              </span>
              {option.value === selectedMode ? <Check className="h-3 w-3 opacity-70" /> : null}
            </DropdownMenuItem>
          );

          if (option.description) {
            return (
              <Tooltip key={option.value} delayDuration={500}>
                <TooltipTrigger asChild>{item}</TooltipTrigger>
                <TooltipContent side="left">{option.description}</TooltipContent>
              </Tooltip>
            );
          }
          return item;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
