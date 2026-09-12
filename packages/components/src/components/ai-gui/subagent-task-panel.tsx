import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, CircleDashed, Loader2, X } from 'lucide-react';
import type { MessageContent } from '@lody/shared';
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/badge';

/**
 * Renders the subagent/background tasks a turn spawned as a single grouped
 * panel, instead of leaking each lifecycle event into the inline transcript.
 *
 * Tasks are persisted as first-class `subagent_task` history items (merged by
 * `taskId`); this panel is a pure view-layer aggregation — it reads those items
 * off the assistant entry and never mutates persisted history.
 */

export type SubagentTask = Extract<MessageContent, { type: 'subagent_task' }>;

const isRunning = (task: SubagentTask): boolean =>
  task.status === 'in_progress' || task.status === 'pending';

/**
 * Extract subagent tasks from an assistant entry's items, in first-seen order,
 * deduped by taskId. Ambient/housekeeping tasks (`skipTranscript`) are omitted
 * from the inline panel per the SDK's guidance.
 */
export const collectSubagentTasks = (items: readonly MessageContent[]): SubagentTask[] => {
  const byId = new Map<string, SubagentTask>();
  for (const item of items) {
    if (item.type !== 'subagent_task' || item.skipTranscript) continue;
    byId.set(item.taskId, item);
  }
  return [...byId.values()];
};

const formatUsage = (usage: SubagentTask['usage']): string | null => {
  if (!usage) return null;
  const parts: string[] = [];
  if (typeof usage.totalTokens === 'number') {
    parts.push(
      usage.totalTokens >= 1000
        ? `${(usage.totalTokens / 1000).toFixed(1)}k tokens`
        : `${usage.totalTokens} tokens`
    );
  }
  if (typeof usage.toolUses === 'number') {
    parts.push(`${usage.toolUses} ${usage.toolUses === 1 ? 'tool' : 'tools'}`);
  }
  return parts.length ? parts.join(' · ') : null;
};

const StatusIcon = ({ task }: { task: SubagentTask }) => {
  if (task.status === 'completed') {
    return <Check className="h-3.5 w-3.5 flex-none shrink-0 text-status-success" />;
  }
  if (task.status === 'failed') {
    return <X className="h-3.5 w-3.5 flex-none shrink-0 text-status-danger" />;
  }
  if (task.status === 'pending') {
    return <CircleDashed className="h-3.5 w-3.5 flex-none shrink-0 text-muted-foreground" />;
  }
  return <Loader2 className="h-3.5 w-3.5 flex-none shrink-0 animate-spin text-muted-foreground" />;
};

const SubagentTaskRow = ({
  task,
  onCancel,
}: {
  task: SubagentTask;
  onCancel?: (taskId: string) => Promise<void>;
}) => {
  const { t } = useTranslation();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string>();

  const actor =
    task.actor ||
    task.subagentType ||
    task.workflowName ||
    (task.taskType === 'local_bash'
      ? t('sessions.subagentTasks.bashActor', 'Bash')
      : t('sessions.subagentTasks.defaultActor', 'Task'));

  // A summary that just wraps the description (the synthesized background-command
  // "…description… completed" text) is noise next to the description column — drop it.
  const description = task.description?.trim();
  const summary = task.summary?.trim();
  const meaningfulSummary =
    summary && (!description || !summary.includes(description)) ? summary : undefined;

  let action: string | null;
  if (task.status === 'failed') {
    action = task.error || t('sessions.subagentTasks.failed', 'Failed');
  } else if (task.status === 'completed') {
    action = meaningfulSummary || t('sessions.subagentTasks.done', 'Done');
  } else if (task.lastToolName) {
    action = t('sessions.subagentTasks.runningTool', 'Running {{tool}}', {
      tool: task.lastToolName,
    });
  } else {
    action = meaningfulSummary || t('sessions.subagentTasks.working', 'Working…');
  }

  const usageLabel = task.status === 'completed' ? formatUsage(task.usage) : null;

  return (
    <div className="flex flex-col gap-0.5 py-1">
      <div className="flex min-w-0 items-center gap-1.5 text-[13px] leading-tight">
        <StatusIcon task={task} />
        <span className="shrink-0 font-medium text-foreground">{actor}</span>
        {task.description ? (
          <>
            <span className="shrink-0 text-muted-foreground/60">·</span>
            <span
              className="min-w-0 flex-1 truncate text-muted-foreground"
              title={task.description}
            >
              {task.description}
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {task.isBackgrounded ? (
          <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px] font-medium">
            {t('sessions.subagentTasks.background', 'Background')}
          </Badge>
        ) : null}
        {action ? (
          <span
            className={cn(
              'max-w-[45%] shrink-0 truncate text-xs',
              task.status === 'failed' ? 'text-status-danger' : 'text-muted-foreground'
            )}
            title={action}
          >
            {action}
          </span>
        ) : null}
        {onCancel && isRunning(task) && task.taskKind === 'subagent' ? (
          <button
            type="button"
            disabled={cancelling}
            className="shrink-0 rounded px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
            aria-label={t('sessions.subagentTasks.cancelNamed', {
              name: task.description || actor,
            })}
            onClick={() => {
              void (async () => {
                setCancelling(true);
                setError(undefined);
                try {
                  await onCancel(task.taskId);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setCancelling(false);
                }
              })();
            }}
          >
            {t(cancelling ? 'sessions.subagentTasks.cancelling' : 'common.cancel')}
          </button>
        ) : null}
      </div>
      {error ? (
        <span role="alert" className="text-xs text-status-danger">
          {error}
        </span>
      ) : null}
      {usageLabel ? (
        <span className="pl-5 text-[11px] font-mono tabular-nums text-muted-foreground/70">
          {usageLabel}
        </span>
      ) : null}
    </div>
  );
};

export const SubagentTaskPanel = ({
  tasks,
  onCancel,
}: {
  tasks: readonly SubagentTask[];
  onCancel?: (taskId: string) => Promise<void>;
}) => {
  const { t } = useTranslation();
  const runningCount = useMemo(() => tasks.filter(isRunning).length, [tasks]);
  const hasRunning = runningCount > 0;
  const [userExpanded, setUserExpanded] = useState(false);

  if (tasks.length === 0) return null;

  // While work is in flight the panel stays open (live status). Once every task
  // has settled it collapses to a one-line summary the user can expand.
  const expanded = hasRunning || userExpanded;
  const canToggle = !hasRunning;

  const headerLabel = hasRunning
    ? t('sessions.subagentTasks.waiting', { count: runningCount })
    : t('sessions.subagentTasks.count', { count: tasks.length });

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 px-2 py-1.5">
      <button
        type="button"
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-muted-foreground transition-colors',
          canToggle ? 'cursor-pointer hover:text-foreground' : 'cursor-default'
        )}
        onClick={canToggle ? () => setUserExpanded((prev) => !prev) : undefined}
        aria-expanded={canToggle ? expanded : undefined}
      >
        {hasRunning ? (
          <Loader2 className="h-3.5 w-3.5 flex-none shrink-0 animate-spin" />
        ) : (
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 flex-none shrink-0 opacity-70 transition-transform duration-200 group-hover:opacity-100',
              expanded ? 'rotate-90' : ''
            )}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{headerLabel}</span>
      </button>
      {expanded ? (
        <div className="scrollbar-pro mt-0.5 max-h-[22rem] divide-y divide-border/40 overflow-y-auto pl-1 pr-1">
          {tasks.map((task) => (
            <SubagentTaskRow key={task.taskId} task={task} onCancel={onCancel} />
          ))}
        </div>
      ) : null}
    </div>
  );
};
