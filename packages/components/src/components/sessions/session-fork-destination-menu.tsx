import { type ReactElement, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Folder } from 'lucide-react';

import { WorktreeIcon } from '@/components/icons/worktree-icon';
import { Menu } from '@/ui/menu';
import { Tooltip } from '@lody/ui/tooltip';

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
  children: ReactElement;
}) {
  return (
    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger delay={400} render={children} />
        <Tooltip.Content side={side} sideOffset={8} className="max-w-64 text-xs leading-snug">
          {description}
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
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
    <Menu.Item
      icon={icon}
      disabled={disabled}
      endContent={
        status ? <span className="text-xs text-muted-foreground">{status}</span> : undefined
      }
      onClick={onSelect}
    >
      {label}
    </Menu.Item>
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
    <>
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
          {nativeForkAvailable && <Menu.Separator />}
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
    </>
  );
}

export function SessionForkDestinationMenu({
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
  children: ReactElement;
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
    <Menu.Root open={resolvedOpen} onOpenChange={handleOpenChange}>
      <Tooltip.Provider>
        <Tooltip.Root open={resolvedOpen ? false : undefined}>
          <Tooltip.Trigger delay={500} render={<Menu.Trigger render={children} disabled={disabled} />} />
          <Tooltip.Content>{tooltipLabel}</Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
      <Menu.Content align={align} side={side} sideOffset={6}>
        <SessionForkDestinationList
          worktreeAvailability={worktreeAvailability}
          nativeForkAvailable={nativeForkAvailable}
          onCopyContext={onCopyContext}
          onSelect={onSelect}
        />
      </Menu.Content>
    </Menu.Root>
  );
}
