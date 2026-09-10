import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Folder } from 'lucide-react';

import { WorktreeIcon } from '@/components/icons/worktree-icon';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { menuItemClassName, menuSurfaceClassName, menuSurfaceStyle } from '@/ui/menu-styles';

export type SessionForkDestination = 'shared' | 'new-worktree';

/** `hidden` means the project cannot offer a worktree fork — callers one-click shared. */
export type SessionForkWorktreeAvailability = 'hidden' | 'available' | 'checking';

type Translate = (key: string, fallback: string) => string;

export function getSessionForkDestinationOptions(
  t: Translate,
  worktreeAvailability: SessionForkWorktreeAvailability
): Array<{
  id: SessionForkDestination;
  label: string;
  hint: string;
  disabled: boolean;
}> {
  const options: Array<{
    id: SessionForkDestination;
    label: string;
    hint: string;
    disabled: boolean;
  }> = [
    {
      id: 'shared',
      label: t('sessions.forkDestination.currentWorkspace', 'Current workspace'),
      hint: t(
        'sessions.forkDestination.currentWorkspaceHint',
        'New tab · shares files and uncommitted changes'
      ),
      disabled: false,
    },
  ];
  if (worktreeAvailability === 'hidden') return options;
  const checking = worktreeAvailability === 'checking';
  options.push({
    id: 'new-worktree',
    label: t('sessions.forkDestination.newWorktree', 'New worktree'),
    hint: checking
      ? t('sessions.forkDestination.newWorktreeChecking', 'Checking Git status…')
      : t(
          'sessions.forkDestination.newWorktreeHint',
          'New session · from the latest committed HEAD'
        ),
    disabled: checking,
  });
  return options;
}

function DestinationRow({
  icon,
  label,
  hint,
  disabled,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(
        menuItemClassName,
        // Popover auto-focuses the first button on open. The shared menu class
        // paints `focus:bg-hover`, which made the first row look selected until
        // the pointer moved. Highlight only on hover or keyboard focus.
        'w-full items-start py-1.5 focus:bg-transparent focus:text-inherit',
        'hover:bg-hover hover:text-hover-foreground',
        'focus-visible:bg-hover focus-visible:text-hover-foreground'
      )}
      onClick={onSelect}
    >
      <span className="flex h-4 shrink-0 items-center text-muted-foreground">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="leading-tight">{label}</span>
        <span className="text-xs font-normal leading-snug text-muted-foreground">{hint}</span>
      </span>
    </button>
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
            hint={option.hint}
            disabled={option.disabled}
            onSelect={() => onSelect(option.id)}
          />
        ))}
      {onCopyContext && (
        <>
          {nativeForkAvailable && <div className="my-1 border-t border-border" />}
          <DestinationRow
            icon={<Copy className="h-3.5 w-3.5" />}
            label={t('sessions.copyContextMarkdown', 'Copy context as Markdown')}
            hint={t(
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
        className={cn('w-64 p-1.5', menuSurfaceClassName)}
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
