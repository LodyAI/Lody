import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Folder } from 'lucide-react';

import { WorktreeIcon } from '@/components/icons/worktree-icon';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import {
  menuItemClassName,
  menuSeparatorClassName,
  menuSurfaceClassName,
  menuSurfaceStyle,
} from '@/ui/menu-styles';

export type SessionForkDestination = 'shared' | 'new-worktree';

/** `hidden` means the project cannot offer a worktree fork — callers one-click shared. */
export type SessionForkWorktreeAvailability = 'hidden' | 'available' | 'checking';

type Translate = (key: string, fallback: string) => string;

export type SessionForkDestinationOption = {
  id: SessionForkDestination;
  label: string;
  /** What the destination does; shown in a hover tooltip, not inline. */
  description: string;
  /** Transient state shown inline (a disabled row cannot raise a tooltip). */
  status?: string;
  disabled: boolean;
};

// "Workspace" names the whole multi-session environment in Lody, so the
// same-directory destination is named for what it creates: a new tab.
export function getSessionForkDestinationOptions(
  t: Translate,
  worktreeAvailability: SessionForkWorktreeAvailability
): SessionForkDestinationOption[] {
  const options: SessionForkDestinationOption[] = [
    {
      id: 'shared',
      label: t('sessions.forkDestination.newTab', 'Fork to new tab'),
      description: t(
        'sessions.forkDestination.newTabHint',
        'Opens a new tab in this session that works in the same directory, sharing its files and uncommitted changes.'
      ),
      disabled: false,
    },
  ];
  if (worktreeAvailability === 'hidden') return options;
  const checking = worktreeAvailability === 'checking';
  options.push({
    id: 'new-worktree',
    label: t('sessions.forkDestination.newWorktree', 'Fork to new worktree'),
    description: t(
      'sessions.forkDestination.newWorktreeHint',
      'Starts a new session in a separate Git worktree from the latest committed HEAD. Uncommitted changes stay here.'
    ),
    status: checking
      ? t('sessions.forkDestination.newWorktreeChecking', 'Checking Git status…')
      : undefined,
    disabled: checking,
  });
  return options;
}

/**
 * Explains a fork destination on hover, beside its row. Width-capped so a long
 * explanation wraps instead of stretching across the conversation.
 */
export function SessionForkOptionTooltip({
  description,
  side = 'right',
  children,
}: {
  description: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
}) {
  return (
    <TooltipProvider>
      <Tooltip delayDuration={400}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={8} className="max-w-64 text-xs leading-snug">
          {description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function DestinationRow({
  icon,
  label,
  description,
  status,
  disabled,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  status?: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  const row = (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(
        menuItemClassName,
        // Popover auto-focuses the first button on open. The shared menu class
        // paints `focus:bg-hover`, which made the first row look selected until
        // the pointer moved. Highlight only on hover or keyboard focus.
        'w-full focus:bg-transparent focus:text-inherit',
        'hover:bg-hover hover:text-hover-foreground',
        'focus-visible:bg-hover focus-visible:text-hover-foreground'
      )}
      onClick={onSelect}
    >
      <span className="flex h-4 shrink-0 items-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {status ? <span className="shrink-0 text-xs text-muted-foreground">{status}</span> : null}
    </button>
  );
  return disabled ? (
    row
  ) : (
    <SessionForkOptionTooltip description={description}>{row}</SessionForkOptionTooltip>
  );
}

export function SessionForkDestinationList({
  worktreeAvailability,
  onSelect,
  onCopyContext,
  nativeForkAvailable = true,
}: {
  onCopyContext?: () => void;
  nativeForkAvailable?: boolean;
  worktreeAvailability: SessionForkWorktreeAvailability;
  onSelect: (destination: SessionForkDestination) => void;
}) {
  const { t } = useTranslation();
  const options = getSessionForkDestinationOptions(t, worktreeAvailability);
  return (
    <div className="flex flex-col">
      {nativeForkAvailable &&
        options.map((option) => (
          <DestinationRow
            key={option.id}
            icon={
              option.id === 'new-worktree' ? (
                <WorktreeIcon className="h-3.5 w-3.5" />
              ) : (
                <Folder className="h-3.5 w-3.5" />
              )
            }
            label={option.label}
            description={option.description}
            status={option.status}
            disabled={option.disabled}
            onSelect={() => onSelect(option.id)}
          />
        ))}
      {onCopyContext && (
        <>
          {nativeForkAvailable && <div className={cn(menuSeparatorClassName, 'my-1')} />}
          <DestinationRow
            icon={<Copy className="h-3.5 w-3.5" />}
            label={t('sessions.copyContextMarkdown', 'Copy context as Markdown')}
            description={t(
              'sessions.copyContextMarkdownHint',
              'Copy the conversation through this message'
            )}
            disabled={false}
            onSelect={onCopyContext}
          />
        </>
      )}
    </div>
  );
}

export function SessionForkDestinationPopover({
  children,
  open,
  onOpenChange,
  worktreeAvailability,
  disabled = false,
  onSelect,
  tooltip,
  onCopyContext,
  nativeForkAvailable,
  side = 'top',
  align = 'start',
}: {
  children: ReactNode;
  onCopyContext?: () => void;
  nativeForkAvailable?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  worktreeAvailability: SessionForkWorktreeAvailability;
  disabled?: boolean;
  onSelect: (destination: SessionForkDestination) => void;
  tooltip?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
}) {
  const { t } = useTranslation();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = open !== undefined;
  const resolvedOpen = isControlled ? open : uncontrolledOpen;
  const tooltipLabel = tooltip ?? t('sessions.forkSession', 'Fork session');

  const handleOpenChange = (next: boolean) => {
    if (disabled) return;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Popover open={resolvedOpen} onOpenChange={handleOpenChange}>
      <TooltipProvider>
        <Tooltip delayDuration={500} open={resolvedOpen ? false : undefined}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild disabled={disabled}>
              {children}
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{tooltipLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        align={align}
        side={side}
        sideOffset={6}
        role="menu"
        aria-label={t('sessions.forkDestination.title', 'Fork conversation')}
        // Same surface as the dropdown menus: the 0.5px edge comes from
        // `menuSurfaceStyle`, so drop Popover's own 1px border. Width follows
        // the rows; 4px padding matches the separator's 4px margins, so every
        // row sits the same distance from the edge or the divider next to it.
        className={cn(menuSurfaceClassName, 'w-max min-w-0 border-0 p-1')}
        style={menuSurfaceStyle}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <SessionForkDestinationList
          worktreeAvailability={worktreeAvailability}
          nativeForkAvailable={nativeForkAvailable}
          onCopyContext={
            onCopyContext
              ? () => {
                  handleOpenChange(false);
                  onCopyContext();
                }
              : undefined
          }
          onSelect={(destination) => {
            handleOpenChange(false);
            onSelect(destination);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
