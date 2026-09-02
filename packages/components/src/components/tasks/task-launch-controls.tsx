import { useTranslation } from 'react-i18next';
import { AlertTriangle, Bot, ChevronRight, FolderGit2, Play } from 'lucide-react';
import type { MachineOnlineStatus } from '@/atoms/presence';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { tasksMenuClassName, tasksMenuSurfaceStyle } from './tasks-surface';

export type TaskAgentOption = {
  agentConfigId: string;
  name: string;
  /** Where this agent lives. Shown as secondary text, not a decision. */
  homeName: string;
  presence: MachineOnlineStatus;
};

export type TaskProjectOption = {
  key: string;
  label: string;
  machineName: string;
  /** False when the selected agent's machine cannot reach this project. */
  reachable: boolean;
};

export type TaskLaunchControlsProps = {
  agent: TaskAgentOption | null;
  agentOptions: readonly TaskAgentOption[];
  onSelectAgent: (agentConfigId: string) => void;
  project: TaskProjectOption | null;
  projectOptions: readonly TaskProjectOption[];
  onSelectProject: (key: string) => void;
  canRun: boolean;
  running?: boolean;
  hasActiveSession?: boolean;
  onRun: () => void;
  /**
   * Handing the task over for unattended execution. Deliberately separate from
   * the agent picker above: picking who runs it once must never enrol the task
   * in automation by itself.
   */
  delegatedTo?: string | null;
  onToggleDelegation?: () => void;
};

const presenceDotClass = (presence: MachineOnlineStatus): string => {
  if (presence === 'online') {
    return 'bg-status-success';
  }
  if (presence === 'offline') {
    return 'bg-muted-foreground/40';
  }
  // Presence not synced yet: an unknown machine must not be drawn as offline.
  return 'bg-muted-foreground/20';
};

function SlotChip({
  icon: Icon,
  label,
  secondary,
  warning,
  children,
}: {
  icon: typeof Bot;
  label: string;
  secondary?: string;
  warning?: boolean;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors',
            warning
              ? 'border-status-warning/40 text-status-warning'
              : 'border-border text-foreground hover:bg-muted-foreground/10',
            label ? '' : 'border-dashed text-muted-foreground'
          )}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
          {secondary ? <span className="truncate text-muted-foreground">· {secondary}</span> : null}
        </button>
      </DropdownMenuTrigger>
      {children}
    </DropdownMenu>
  );
}

/**
 * Run button plus the slot chain that says where the work will happen.
 *
 * The slots read agent-first: you pick who does the work, and the machine is a
 * property of that agent rather than a coordinate the user navigates. A project
 * the agent cannot reach is shown disabled with the reason instead of being
 * filtered out — an absent option cannot explain itself.
 */
export function TaskLaunchControls({
  agent,
  agentOptions,
  onSelectAgent,
  project,
  projectOptions,
  onSelectProject,
  canRun,
  running = false,
  hasActiveSession = false,
  onRun,
  delegatedTo,
  onToggleDelegation,
}: TaskLaunchControlsProps) {
  const { t } = useTranslation();
  const reachable = projectOptions.filter((option) => option.reachable);
  const unreachable = projectOptions.filter((option) => !option.reachable);
  const agentOffline = agent?.presence === 'offline';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant={hasActiveSession ? 'secondary' : 'primary'}
        // Without `canRun` the dispatch would reject on missing fields and the
        // click would look like nothing happened. The hint below says what is
        // missing; the button must not invite a no-op press.
        size="small"
        disabled={running || !canRun}
        onClick={onRun}
      >
        <Play className="h-3.5 w-3.5" />
        {running ? t('tasks.run.starting', 'Starting…') : t('tasks.run.label', 'Run')}
      </Button>

      <SlotChip
        icon={Bot}
        label={agent?.name ?? t('tasks.slots.chooseAgent', 'Choose agent')}
        secondary={agent?.homeName}
        warning={agentOffline}
      >
        <DropdownMenuContent
          align="start"
          className={tasksMenuClassName('w-72')}
          style={tasksMenuSurfaceStyle}
        >
          <DropdownMenuLabel>{t('tasks.slots.agent', 'Agent')}</DropdownMenuLabel>
          {agentOptions.length === 0 ? (
            <DropdownMenuItem disabled>
              {t('tasks.slots.noAgents', 'No agents configured')}
            </DropdownMenuItem>
          ) : (
            agentOptions.map((option) => (
              <DropdownMenuItem
                key={option.agentConfigId}
                onClick={() => onSelectAgent(option.agentConfigId)}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    presenceDotClass(option.presence)
                  )}
                />
                <span className="truncate">{option.name}</span>
                <span className="ml-auto truncate text-xs text-muted-foreground">
                  {option.homeName}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </SlotChip>

      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />

      <SlotChip
        icon={FolderGit2}
        label={project?.label ?? t('tasks.slots.chooseProject', 'Choose project')}
      >
        <DropdownMenuContent
          align="start"
          className={tasksMenuClassName('w-80')}
          style={tasksMenuSurfaceStyle}
        >
          <DropdownMenuLabel>{t('tasks.slots.project', 'Project')}</DropdownMenuLabel>
          {reachable.map((option) => (
            <DropdownMenuItem key={option.key} onClick={() => onSelectProject(option.key)}>
              <span className="truncate">{option.label}</span>
              <span className="ml-auto truncate text-xs text-muted-foreground">
                {option.machineName}
              </span>
            </DropdownMenuItem>
          ))}
          {unreachable.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                {t('tasks.slots.unreachableGroup', 'Not on {{agent}}’s computer ({{count}})', {
                  agent: agent?.name ?? t('tasks.slots.thisAgent', 'this agent'),
                  count: unreachable.length,
                })}
              </DropdownMenuLabel>
              {unreachable.map((option) => (
                <DropdownMenuItem key={option.key} disabled>
                  <span className="truncate text-muted-foreground">{option.label}</span>
                  <span className="ml-auto truncate text-xs text-muted-foreground/70">
                    {option.machineName}
                  </span>
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
          {projectOptions.length === 0 ? (
            <DropdownMenuItem disabled>
              {t('tasks.slots.noProjects', 'No projects available')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </SlotChip>

      {agentOffline ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1 text-xs text-status-warning">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('tasks.run.agentOffline', '{{agent}} is offline', {
                agent: agent?.name ?? '',
              })}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {t('tasks.run.agentOfflineHint', '{{home}} is not online right now.', {
              home: agent?.homeName ?? '',
            })}
          </TooltipContent>
        </Tooltip>
      ) : null}

      {!canRun && !agentOffline ? (
        <span className="text-xs text-muted-foreground">
          {t('tasks.run.missingFields', 'Pick an agent and a project to run this task.')}
        </span>
      ) : null}

      {onToggleDelegation ? (
        <label
          className={cn(
            'flex w-full cursor-pointer select-none items-center gap-2 text-xs',
            // Off is an offer, so it stays quiet. On means this task will start
            // itself with nobody watching — the most consequential state in this
            // panel, and it must not read like the hint text beside it.
            delegatedTo ? 'font-medium text-foreground' : 'text-muted-foreground'
          )}
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-primary"
            checked={Boolean(delegatedTo)}
            // Gated on having someone to hand it to, NOT on canRun: a task
            // delegated before its project is set is a real state the board
            // warns about, and requiring canRun would make that unreachable.
            // It also stops a hand-over with no agent id behind it.
            disabled={!agent && !delegatedTo}
            onChange={onToggleDelegation}
          />
          {delegatedTo
            ? t('tasks.delegate.on', '{{agent}} will pick this up on its own', {
                agent: delegatedTo,
              })
            : t('tasks.delegate.off', 'Let this agent start it without me')}
        </label>
      ) : null}
    </div>
  );
}
