import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, GitPullRequest, Play, Tag, User, Zap } from 'lucide-react';
import {
  TASK_SUGGESTED_LABELS,
  normalizeTaskLabel,
  type ProjectRef,
  type TaskAgentRef,
  type TaskPriority,
  type TaskStatus,
} from '@lody/shared';
import type { MachineOnlineStatus } from '@/atoms/presence';
import type { UnifiedLocalProjectOption } from '@/components/chat/unified-project-selector';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { CachedAvatarImg } from '@/components/cached-avatar-img';
import { getTaskStatusPresentation, TASK_STATUS_PRESENTATION } from './task-status-presentation';
import {
  getTaskPriorityPresentation,
  TASK_PRIORITY_PRESENTATION,
} from './task-priority-presentation';
import { taskLabelDotStyle, taskLabelPillStyle } from './task-label-presentation';
import type { TaskAgentOption } from './task-launch-controls';
import { TaskAgentRunConfigMenu } from './task-agent-run-config-menu';
import { TaskProjectSelector } from './task-project-selector';
import { tasksMenuClassName, tasksMenuSurfaceStyle } from './tasks-surface';

/** A workspace member who can own a task. Owners are always human. */
export type TaskOwnerOption = {
  userId: string;
  name: string;
  image?: string | null;
};

/** A pull request linked to this task, for the read-only PR row. */
export type TaskPrRow = {
  id: string;
  url: string;
  label: string;
};

export type TaskPropertiesPanelProps = {
  status: TaskStatus;
  onStatusChange: (status: TaskStatus) => void;
  /**
   * Owner is always a human (or empty when unassigned). The picker spans every
   * workspace member plus a clear option.
   */
  ownerId: string;
  members: ReadonlyArray<TaskOwnerOption>;
  onOwnerChange: (userId: string | null) => void;
  /** `null` means no priority. */
  priority: TaskPriority | null;
  onPriorityChange: (priority: TaskPriority | null) => void;
  labels: readonly string[];
  onLabelsChange: (labels: string[]) => void;
  prLinks?: ReadonlyArray<TaskPrRow>;
  onOpenPr?: (url: string) => void;
  /** Display helper for presence trailing on the agent row. */
  agent: TaskAgentOption | null;
  /** Full run-config selection (writes lastRunConfig). */
  runAgent: TaskAgentRef | null;
  onSelectRunAgent: (next: TaskAgentRef) => void;
  project: ProjectRef | null;
  onSelectProject: (project: ProjectRef | null) => void;
  localProjects: ReadonlyArray<UnifiedLocalProjectOption>;
  repositories?: ReadonlyArray<{ fullName: string; description?: string | null }>;
  latestMessageAtByRepo?: ReadonlyMap<string, number>;
  onAddLocalProject: () => void;
  onConnectGitRepo: () => void;
  canRun: boolean;
  running?: boolean;
  hasActiveSession?: boolean;
  onRun: () => void;
  delegatedTo?: string | null;
  onToggleDelegation?: () => void;
  disabled?: boolean;
};

const presenceDotClass = (presence: MachineOnlineStatus): string => {
  if (presence === 'online') return 'bg-status-success';
  if (presence === 'offline') return 'bg-status-warning';
  return 'bg-muted-foreground/30';
};

const propertyRowClass =
  'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-hover';

/** Avatar, initial, or nothing — never the raw user id. */
function TaskOwnerAvatar({ owner }: { owner: TaskOwnerOption }) {
  if (owner.image) {
    return (
      <CachedAvatarImg
        src={owner.image}
        alt={owner.name}
        className="h-4 w-4 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted-foreground/20 text-[9px] font-medium uppercase text-muted-foreground">
      {owner.name.slice(0, 1)}
    </span>
  );
}
/**
 * Full-width ghost property row. Same surface as the project selector's
 * `property-row` trigger so Status / Agent / Project read as one family.
 */
function PropertyButton({
  icon: Icon,
  iconClassName,
  value,
  valueContent,
  placeholder,
  leading,
  trailing,
  disabled,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
  value?: string | null;
  /**
   * Rich value (e.g. colored label pills). When set, replaces the plain text
   * value; emptiness for placeholder still uses `value`.
   */
  valueContent?: React.ReactNode;
  placeholder: string;
  /** Replaces the icon when the row has a richer glyph (e.g. an avatar). */
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const hasValue = Boolean(value) || valueContent != null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(propertyRowClass, hasValue ? 'text-foreground' : 'text-muted-foreground')}
        >
          {leading ?? <Icon className={cn('h-3.5 w-3.5 shrink-0 opacity-70', iconClassName)} />}
          {valueContent != null ? (
            <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              {valueContent}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate">{value || placeholder}</span>
          )}
          {trailing}
        </button>
      </DropdownMenuTrigger>
      {children}
    </DropdownMenu>
  );
}

/**
 * Right-rail properties for a task detail page (Linear issue layout).
 *
 * One uniform list of quiet property rows — status, owner, priority, labels,
 * agent (carrying Run), project, auto-run, and any linked pull requests. Run
 * sits on the agent row because it acts on exactly that agent; everything else
 * that is a durable fact about the task is a row, so nothing floats loose.
 * Project reuses the chat landing searchable menu with a matching full-width
 * trigger — no mixed chip chrome in the rail.
 */
export function TaskPropertiesPanel({
  status,
  onStatusChange,
  ownerId,
  members,
  onOwnerChange,
  priority,
  onPriorityChange,
  labels,
  onLabelsChange,
  prLinks,
  onOpenPr,
  agent,
  runAgent,
  onSelectRunAgent,
  project,
  onSelectProject,
  localProjects,
  repositories,
  latestMessageAtByRepo,
  onAddLocalProject,
  onConnectGitRepo,
  canRun,
  running = false,
  hasActiveSession = false,
  onRun,
  delegatedTo,
  onToggleDelegation,
  disabled = false,
}: TaskPropertiesPanelProps) {
  const { t } = useTranslation();
  const presentation = getTaskStatusPresentation(status);
  const priorityPresentation = getTaskPriorityPresentation(priority);
  const agentOffline = agent?.presence === 'offline';
  const agentUnknown = agent?.presence === 'unknown';
  const owner = members.find((member) => member.userId === ownerId) ?? null;
  // An owner id with no matching member (someone who left, or members still
  // loading) shows nothing rather than the raw id — an opaque identifier in the
  // UI is worse than an empty slot.
  const ownerName = owner?.name ?? null;
  const prRows = prLinks ?? [];
  // Suggestions first, then whatever this task already carries, so a label
  // someone added by hand stays visible and removable in the same menu.
  const labelOptions = [
    ...TASK_SUGGESTED_LABELS,
    ...labels.map(normalizeTaskLabel).filter((label) => !TASK_SUGGESTED_LABELS.includes(label)),
  ];

  const runTooltip = running
    ? t('tasks.run.starting', 'Starting…')
    : hasActiveSession
      ? t('tasks.run.openSession', 'Running')
      : !canRun
        ? !agent
          ? t('tasks.run.needAgent', 'Choose an agent to run this task.')
          : !project
            ? t('tasks.run.needProject', 'Choose a project to run this task.')
            : t('tasks.run.missingFields', 'Pick an agent and a project to run this task.')
        : agentOffline
          ? t(
              'tasks.run.agentOfflineHint',
              '{{home}} is not online right now — the run will wait until it is.',
              { home: agent?.homeName ?? agent?.name ?? '' }
            )
          : t('tasks.run.label', 'Run');

  const agentTrailing =
    agent && (agentOffline || agentUnknown) ? (
      <span
        className={cn(
          'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
          agentOffline
            ? 'bg-status-warning/12 text-status-warning'
            : 'bg-muted-foreground/10 text-muted-foreground'
        )}
      >
        {agentOffline
          ? t('tasks.slots.offline', 'Offline')
          : t('tasks.slots.unknownPresence', 'Unknown')}
      </span>
    ) : agent ? (
      <span
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', presenceDotClass(agent.presence))}
        aria-hidden
      />
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col">
        <h2 className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
          {t('tasks.properties.title', 'Properties')}
        </h2>

        <div className="flex flex-col">
          <PropertyButton
            icon={presentation.Icon}
            iconClassName={presentation.className}
            value={t(presentation.labelKey, presentation.labelFallback)}
            placeholder={t('tasks.status.unknown', 'Status')}
            disabled={disabled}
          >
            <DropdownMenuContent
              align="start"
              className={tasksMenuClassName('w-52')}
              style={tasksMenuSurfaceStyle}
            >
              {TASK_STATUS_PRESENTATION.map((option) => (
                <DropdownMenuItem key={option.status} onClick={() => onStatusChange(option.status)}>
                  <option.Icon className={cn('h-3.5 w-3.5', option.className)} />
                  {t(option.labelKey, option.labelFallback)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </PropertyButton>

          <PropertyButton
            icon={User}
            value={ownerName}
            placeholder={t('tasks.properties.owner', 'Owner')}
            disabled={disabled}
            leading={owner ? <TaskOwnerAvatar owner={owner} /> : undefined}
          >
            <DropdownMenuContent
              align="start"
              className={tasksMenuClassName('max-h-72 w-56 overflow-y-auto')}
              style={tasksMenuSurfaceStyle}
            >
              <DropdownMenuItem onClick={() => onOwnerChange(null)}>
                <User className="h-3.5 w-3.5 text-muted-foreground/50" />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {t('tasks.properties.noOwner', 'No owner')}
                </span>
              </DropdownMenuItem>
              {members.length === 0 ? (
                <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
                  {t('tasks.properties.noMembers', 'No workspace members')}
                </div>
              ) : (
                members.map((member) => (
                  <DropdownMenuItem
                    key={member.userId}
                    onClick={() => onOwnerChange(member.userId)}
                  >
                    <TaskOwnerAvatar owner={member} />
                    <span className="min-w-0 flex-1 truncate">{member.name}</span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </PropertyButton>

          <PropertyButton
            icon={priorityPresentation.Icon}
            iconClassName={priorityPresentation.className}
            value={
              priority ? t(priorityPresentation.labelKey, priorityPresentation.labelFallback) : null
            }
            placeholder={t('tasks.properties.priority', 'Priority')}
            disabled={disabled}
          >
            <DropdownMenuContent
              align="start"
              className={tasksMenuClassName('w-44')}
              style={tasksMenuSurfaceStyle}
            >
              {TASK_PRIORITY_PRESENTATION.map((option) => (
                <DropdownMenuItem
                  key={option.priority ?? 'none'}
                  onClick={() => onPriorityChange(option.priority)}
                >
                  <option.Icon className={cn('h-3.5 w-3.5', option.className)} />
                  {t(option.labelKey, option.labelFallback)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </PropertyButton>

          <PropertyButton
            icon={Tag}
            value={labels.length > 0 ? labels.join(', ') : null}
            valueContent={
              labels.length > 0 ? (
                <>
                  {labels.map((label) => (
                    <span
                      key={label}
                      className="inline-flex h-5 max-w-[7.5rem] shrink-0 items-center truncate rounded-full border px-1.5 text-[11px] font-medium leading-none"
                      style={taskLabelPillStyle(label)}
                    >
                      {label}
                    </span>
                  ))}
                </>
              ) : undefined
            }
            placeholder={t('tasks.properties.labels', 'Labels')}
            disabled={disabled}
          >
            <DropdownMenuContent
              align="start"
              className={tasksMenuClassName('w-52')}
              style={tasksMenuSurfaceStyle}
            >
              {labelOptions.map((label) => {
                const active = labels.includes(label);
                return (
                  <DropdownMenuItem
                    key={label}
                    // Multi-select: keep the menu open so several labels can be
                    // set in one pass instead of reopening per label.
                    onSelect={(event) => {
                      event.preventDefault();
                      onLabelsChange(
                        active ? labels.filter((it) => it !== label) : [...labels, label]
                      );
                    }}
                  >
                    {/* Color dot first (Linear), then the name; selection is the
                        trailing check so the hue stays visible either way. */}
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={taskLabelDotStyle(label)}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {active ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
                    ) : (
                      <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </PropertyButton>

          {/* Agent row carries Run on its right: the button acts on exactly the
             agent named beside it, so the two belong on one line. */}
          <div
            className={cn('flex items-center gap-1', disabled && 'pointer-events-none opacity-50')}
          >
            <div className="min-w-0 flex-1">
              <TaskAgentRunConfigMenu
                value={runAgent}
                onChange={onSelectRunAgent}
                disabled={disabled}
                trailing={agentTrailing}
              />
            </div>
            {/* Run + execution mode are one control: the button's glyph IS the
               mode readout (▶ you start it, ⚡ the agent does), and the chevron
               beside it is where that mode is changed. Splitting them into a
               button here and a property row elsewhere made the same fact live
               in two places. */}
            <div className="flex shrink-0 items-center">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      // Only a ready, manual task gets the solid primary: a
                      // green Run that cannot fire reads as broken.
                      variant={canRun && !hasActiveSession && !delegatedTo ? 'primary' : 'ghost'}
                      icon
                      className="shrink-0"
                      // Delegated tasks are started by the scheduler, so the
                      // button becomes a state readout rather than an action.
                      disabled={disabled || running || !canRun || Boolean(delegatedTo)}
                      onClick={onRun}
                      aria-label={
                        delegatedTo
                          ? t('tasks.autoRun.on', 'Runs automatically · {{agent}}', {
                              agent: delegatedTo,
                            })
                          : t('tasks.run.label', 'Run')
                      }
                    >
                      {delegatedTo ? (
                        <Zap className="h-3.5 w-3.5" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {delegatedTo
                    ? t(
                        'tasks.autoRun.onHint',
                        '{{agent}} starts this on its own — no need to press Run.',
                        { agent: delegatedTo }
                      )
                    : runTooltip}
                </TooltipContent>
              </Tooltip>

              {onToggleDelegation ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      icon
                      className="shrink-0"
                      disabled={disabled || (!agent && !delegatedTo)}
                      aria-label={t('tasks.properties.autoRun', 'Execution')}
                    >
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className={tasksMenuClassName('w-72')}
                    style={tasksMenuSurfaceStyle}
                  >
                    <DropdownMenuItem
                      className="flex-col items-start gap-0.5"
                      onClick={() => {
                        if (delegatedTo) onToggleDelegation();
                      }}
                    >
                      <span className="flex items-center gap-1.5 font-medium">
                        <Play className="h-3 w-3" />
                        {t('tasks.autoRun.manualTitle', 'Run manually')}
                      </span>
                      <span className="text-[11px] leading-snug text-muted-foreground">
                        {t('tasks.autoRun.manualHint', 'Only starts when you press Run.')}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="flex-col items-start gap-0.5"
                      onClick={() => {
                        if (!delegatedTo) onToggleDelegation();
                      }}
                    >
                      <span className="flex items-center gap-1.5 font-medium">
                        <Zap className="h-3 w-3" />
                        {t('tasks.autoRun.delegatedTitle', 'Run automatically')}
                      </span>
                      <span className="text-[11px] leading-snug text-muted-foreground">
                        {t(
                          'tasks.autoRun.delegatedHint',
                          'The agent starts this on its own once it is ready — including while this app is closed.'
                        )}
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>

          <div className={cn(disabled && 'pointer-events-none opacity-50')}>
            <TaskProjectSelector
              value={project}
              onChange={onSelectProject}
              localProjects={localProjects}
              repositories={repositories}
              latestMessageAtByRepo={latestMessageAtByRepo}
              onAddLocalProject={onAddLocalProject}
              onConnectGitRepo={onConnectGitRepo}
              contentSide="bottom"
              triggerVariant="property-row"
            />
          </div>

          {prRows.length > 0 ? (
            <div className="flex flex-col">
              {prRows.map((pr) => (
                <button
                  key={pr.id}
                  type="button"
                  className={cn(propertyRowClass, 'text-foreground')}
                  onClick={() => onOpenPr?.(pr.url)}
                >
                  <GitPullRequest className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">{pr.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
