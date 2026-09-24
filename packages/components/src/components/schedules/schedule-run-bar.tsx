import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ExternalLink,
  MessageSquare,
  MessagesSquare,
  RotateCcw,
} from 'lucide-react';
import type { ScheduleDestination } from '@lody/shared';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * A control in the editor's run bar — the row along the bottom of the prompt
 * box, like the composer's model and mode triggers: ghost, muted, one line.
 * Every pill in the bar (destination, chat, Agent, project) uses this so the
 * bar reads as one strip rather than four different widgets.
 */
export const runPillClass =
  'flex h-7 min-w-0 max-w-full shrink-0 items-center gap-1.5 rounded-md px-2 text-[0.9em] font-normal text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-foreground/[0.05] data-[state=open]:text-foreground dark:hover:bg-white/[0.08] dark:data-[state=open]:bg-white/[0.08] [&>svg]:size-3.5 [&>svg]:shrink-0';

/** The composer's worktree checkbox, flattened to the same ghost pill. */
export const runWorktreePillClass =
  'ml-0.5 h-7 bg-transparent px-2 text-[0.9em] hover:bg-foreground/[0.05] dark:hover:bg-white/[0.08]';

/** The same pill carrying a problem: warning ink, so the mark is not alone. */
export const runPillIssueClass = 'text-status-warning hover:text-status-warning';

/**
 * The exclamation mark shown next to the control that fixes a save blocker.
 * The reason is its accessible name and its tooltip, so nothing is listed at
 * the bottom of the form.
 */
export function FieldIssueMark({
  messages,
  className,
}: {
  messages: readonly string[];
  className?: string;
}) {
  if (messages.length === 0) return null;
  const label = messages.join(' ');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          tabIndex={0}
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded-full text-status-warning focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
            className
          )}
        >
          <AlertCircle className="size-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {messages.length === 1 ? (
          messages[0]
        ) : (
          <ul className="space-y-0.5">
            {messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export type PickableSession = {
  id: string;
  title: string;
  /** Secondary line: "Code reviewer · MacBook Pro". */
  detail?: string;
};

const DESTINATION_KINDS = ['new_session', 'own_session', 'existing_session'] as const;

/**
 * Where each run's prompt goes, as one menu: a fresh chat every time, one chat
 * this task keeps appending to, or a chat the person already has. When the task
 * owns a chat that already exists, the same menu opens it or starts over.
 */
export function ScheduleDestinationPill({
  value,
  onChange,
  ownSession,
  onOpenSession,
  issues = [],
  disabled,
}: {
  value: ScheduleDestination;
  onChange: (next: ScheduleDestination) => void;
  /** The chat this schedule owns, once the first run has created it. */
  ownSession?: PickableSession | null;
  onOpenSession?: (id: string) => void;
  issues?: readonly string[];
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const labels: Record<ScheduleDestination['kind'], string> = {
    new_session: t('schedules.destination.newSession', 'New chat each run'),
    own_session: t('schedules.destination.ownSession', 'One chat for this task'),
    existing_session: t('schedules.destination.existingSession', 'An existing chat'),
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={t('schedules.sendTo', 'Send to')}
          className={cn(runPillClass, issues.length > 0 && runPillIssueClass)}
        >
          {value.kind === 'new_session' ? <MessageSquare /> : <MessagesSquare />}
          <span className="truncate text-foreground">{labels[value.kind]}</span>
          <ChevronDown className="opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuRadioGroup
          value={value.kind}
          onValueChange={(kind) => {
            if (kind === value.kind || !(DESTINATION_KINDS as readonly string[]).includes(kind))
              return;
            onChange(
              kind === 'own_session'
                ? { kind, epoch: 0 }
                : kind === 'existing_session'
                  ? { kind, sessionId: '' }
                  : { kind: 'new_session' }
            );
          }}
        >
          {DESTINATION_KINDS.map((kind) => (
            <DropdownMenuRadioItem key={kind} value={kind}>
              {labels[kind]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {value.kind === 'own_session' && ownSession ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onOpenSession?.(ownSession.id)}>
              <ExternalLink />
              <span className="truncate">
                {t('schedules.destination.openChat', 'Open “{{title}}”', {
                  title: ownSession.title,
                })}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onChange({ kind: 'own_session', epoch: value.epoch + 1 })}
            >
              <RotateCcw />
              {t('schedules.destination.startNewChat', 'Start a new chat')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The chat an `existing_session` schedule sends into. */
export function ScheduleChatPill({
  sessions,
  value,
  label,
  onChange,
  issues = [],
  disabled,
}: {
  sessions: readonly PickableSession[];
  value: string;
  label?: string;
  onChange: (sessionId: string) => void;
  issues?: readonly string[];
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={t('schedules.destination.chooseChat', 'Choose a chat')}
          disabled={disabled}
          className={cn(runPillClass, 'max-w-64', issues.length > 0 && runPillIssueClass)}
        >
          <MessageSquare />
          <span className={cn('truncate', label && 'text-foreground')}>
            {label ?? t('schedules.destination.chooseChat', 'Choose a chat')}
          </span>
          <ChevronDown className="opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <Command>
          <CommandInput placeholder={t('schedules.destination.searchChats', 'Search chats')} />
          <CommandList>
            <CommandEmpty>{t('schedules.destination.noChats', 'No chats found')}</CommandEmpty>
            {sessions.map((session) => (
              <CommandItem
                key={session.id}
                value={`${session.title} ${session.detail ?? ''} ${session.id}`}
                onSelect={() => {
                  onChange(session.id);
                  setOpen(false);
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{session.title}</span>
                  {session.detail ? (
                    <span className="truncate text-[0.85em] text-muted-foreground">
                      {session.detail}
                    </span>
                  ) : null}
                </span>
                {session.id === value ? <Check className="size-4 shrink-0" /> : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** One item in the run bar with its problem mark beside it. */
export function RunBarItem({ children, issues }: { children: ReactNode; issues: string[] }) {
  return (
    <span className="flex min-w-0 max-w-full items-center">
      {children}
      <FieldIssueMark messages={issues} className="-ml-0.5 mr-1" />
    </span>
  );
}
