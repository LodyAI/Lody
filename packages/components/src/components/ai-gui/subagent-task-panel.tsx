import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, CircleDashed, Copy, X } from 'lucide-react';
import { Spinner } from '@/ui/spinner';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
import type { MessageContent } from '@lody/shared';
import { formatDurationCompact } from '@/lib/format-duration';
import { writeTextToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

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
  return <Spinner className="h-3.5 w-3.5 flex-none shrink-0 text-muted-foreground" />;
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
  const [detailsOpen, setDetailsOpen] = useState(false);

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

  // The leading status icon already says running/done/failed; the trailing text
  // only carries information the icon cannot (an error, a summary, a live tool).
  let action: string | undefined;
  if (task.status === 'failed') {
    action = task.error;
  } else if (task.status === 'completed') {
    action = meaningfulSummary;
  } else if (task.lastToolName) {
    action = t('sessions.subagentTasks.runningTool', 'Running {{tool}}', {
      tool: task.lastToolName,
    });
  } else {
    action = meaningfulSummary;
  }

  const usageLabel = task.status === 'completed' ? formatUsage(task.usage) : null;

  return (
    <div className="flex flex-col gap-0.5 py-0.5">
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left text-[13px] leading-tight',
            'transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
          )}
          aria-haspopup="dialog"
          onClick={() => setDetailsOpen(true)}
        >
          <StatusIcon task={task} />
          <span className="shrink-0 font-medium text-foreground">{actor}</span>
          {task.description ? (
            <>
              <span className="shrink-0 text-muted-foreground/60">·</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {task.description}
              </span>
            </>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          {action ? (
            <span
              className={cn(
                'max-w-[45%] shrink-0 truncate text-xs',
                task.status === 'failed' ? 'text-status-danger' : 'text-muted-foreground'
              )}
            >
              {action}
            </span>
          ) : null}
        </button>
        {onCancel && isRunning(task) && task.taskKind === 'subagent' ? (
          <button
            type="button"
            disabled={cancelling}
            className="shrink-0 rounded px-2 py-1 text-xs hover:bg-hover disabled:opacity-50"
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
        <span role="alert" className="px-1 text-xs text-status-danger">
          {error}
        </span>
      ) : null}
      {usageLabel ? (
        <span className="pl-6 text-[11px] font-mono tabular-nums text-muted-foreground/70">
          {usageLabel}
        </span>
      ) : null}
      <SubagentTaskDetailsDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        task={task}
        actor={actor}
        result={meaningfulSummary}
        usageLabel={formatUsage(task.usage)}
      />
    </div>
  );
};

const STATUS_LABEL_KEYS: Record<SubagentTask['status'], [string, string]> = {
  pending: ['sessions.subagentTasks.statusPending', 'Pending'],
  in_progress: ['sessions.subagentTasks.statusRunning', 'Running'],
  completed: ['sessions.subagentTasks.statusCompleted', 'Completed'],
  failed: ['sessions.subagentTasks.statusFailed', 'Failed'],
};

/** The full task: the row truncates its command/description to one line. */
const SubagentTaskDetailsDialog = ({
  open,
  onOpenChange,
  task,
  actor,
  result,
  usageLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: SubagentTask;
  actor: string;
  result?: string;
  usageLabel: string | null;
}) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const isCommand = task.taskType === 'local_bash';
  const body = task.description?.trim();
  const [statusKey, statusFallback] = STATUS_LABEL_KEYS[task.status];
  const durationMs =
    typeof task.startedAtEpochSeconds === 'number' && typeof task.endedAtEpochSeconds === 'number'
      ? Math.max(0, (task.endedAtEpochSeconds - task.startedAtEpochSeconds) * 1000)
      : null;
  const meta = [
    t(statusKey, statusFallback),
    durationMs === null
      ? null
      : formatDurationCompact(durationMs, {
          hour: t('time.unitShort.hour', 'h'),
          minute: t('time.unitShort.minute', 'm'),
          second: t('time.unitShort.second', 's'),
        }),
    usageLabel,
  ].filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col gap-0 p-0 sm:p-0">
        <div className="flex min-w-0 items-center gap-2 border-b border-border/60 py-3 pl-5 pr-12">
          <StatusIcon task={task} />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base font-medium">{actor}</DialogTitle>
            <DialogDescription className="text-xs tabular-nums">
              {meta.join(' · ')}
            </DialogDescription>
          </div>
        </div>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4 text-sm">
          {body ? (
            <section className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {isCommand
                    ? t('sessions.subagentTasks.command', 'Command')
                    : t('sessions.subagentTasks.description', 'Description')}
                </h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    void writeTextToClipboard(body).then((ok) => {
                      if (ok) setCopied(true);
                    });
                  }}
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}
                </Button>
              </div>
              <pre
                className={cn(
                  'scrollbar-pro max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[12.5px] leading-relaxed',
                  isCommand ? 'font-mono' : 'font-sans'
                )}
              >
                {body}
              </pre>
            </section>
          ) : null}
          {task.status === 'failed' && task.error ? (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t('sessions.subagentTasks.error', 'Error')}
              </h3>
              <p className="whitespace-pre-wrap break-words text-status-danger">{task.error}</p>
            </section>
          ) : null}
          {result ? (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t('sessions.subagentTasks.result', 'Result')}
              </h3>
              <p className="whitespace-pre-wrap break-words text-foreground">{result}</p>
            </section>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
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

  // Background-ness is stated once in the header rather than badged per row.
  const backgroundCount = tasks.filter((task) => task.isBackgrounded).length;
  const allBackground = backgroundCount === tasks.length;
  const headerLabel = allBackground
    ? hasRunning
      ? t('sessions.subagentTasks.waitingBackground', { count: runningCount })
      : t('sessions.subagentTasks.countBackground', { count: tasks.length })
    : hasRunning
      ? t('sessions.subagentTasks.waiting', { count: runningCount })
      : t('sessions.subagentTasks.count', { count: tasks.length });
  const mixedBackgroundLabel =
    !allBackground && backgroundCount > 0
      ? t('sessions.subagentTasks.backgroundCount', { count: backgroundCount })
      : null;

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
          <Spinner className="h-3.5 w-3.5 flex-none shrink-0" />
        ) : (
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 flex-none shrink-0 opacity-70 transition-transform duration-200 group-hover:opacity-100',
              expanded ? 'rotate-90' : ''
            )}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {headerLabel}
          {mixedBackgroundLabel ? (
            <span className="font-normal text-muted-foreground/70">
              {' · '}
              {mixedBackgroundLabel}
            </span>
          ) : null}
        </span>
      </button>
      {expanded ? (
        <div className="scrollbar-pro mt-0.5 max-h-[22rem] divide-y divide-border/40 overflow-y-auto">
          {tasks.map((task) => (
            <SubagentTaskRow key={task.taskId} task={task} onCancel={onCancel} />
          ))}
        </div>
      ) : null}
    </div>
  );
};
