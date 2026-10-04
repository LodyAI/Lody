import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { MessageContent } from '@lody/shared';
import { formatDurationCompact, getDurationUnitLabels } from '@/lib/format-duration';
import { formatCompactNumber } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { useStableNow } from '@/hooks/use-stable-now';

export type SubagentTask = Extract<MessageContent, { type: 'subagent_task' }>;
type SubagentRunItem = NonNullable<SubagentTask['run']>['items'][number];

/**
 * A task's state. A task carrying a normalized run reads its snapshot, which
 * can say cancelled or unknown; a legacy task has only the four-state status.
 */
export type TaskState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export const stateOf = (task: SubagentTask): TaskState => {
  if (task.run) return task.run.snapshot.state;
  return task.status === 'in_progress' ? 'running' : task.status;
};

/**
 * Still worth waiting on. `unknown` is not: Lody lost sight of the run, and a
 * group that said "Waiting on" it would wait forever.
 */
export const isRunning = (task: SubagentTask): boolean => {
  const state = stateOf(task);
  return state === 'running' || state === 'pending';
};

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

/** Deepest indent a nested run takes; deeper ones share it rather than run off the card. */
const MAX_DEPTH = 2;

/**
 * The tasks in reading order: a run a subagent started sits under the run that
 * started it. A parent this group does not hold, or a cycle, leaves the task
 * top-level — a task is never hidden by its lineage.
 */
export const orderAsTree = (tasks: readonly SubagentTask[]) => {
  const ids = new Set(tasks.map((task) => task.taskId));
  const children = new Map<string, SubagentTask[]>();
  const roots: SubagentTask[] = [];
  for (const task of tasks) {
    const parent = task.parentTaskId;
    if (parent && parent !== task.taskId && ids.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), task]);
    } else {
      roots.push(task);
    }
  }
  const ordered: Array<{ task: SubagentTask; depth: number }> = [];
  const placed = new Set<string>();
  const place = (task: SubagentTask, depth: number) => {
    if (placed.has(task.taskId)) return;
    placed.add(task.taskId);
    ordered.push({ task, depth: Math.min(depth, MAX_DEPTH) });
    for (const child of children.get(task.taskId) ?? []) place(child, depth + 1);
  };
  for (const root of roots) place(root, 0);
  // Members of a parent cycle have no root to hang from.
  for (const task of tasks) place(task, 0);
  return ordered;
};

/** Tokens and tool calls, from the run's live progress when it has one. */
export const useUsageLabel = (task: SubagentTask): string | null => {
  const { t, i18n } = useTranslation();
  const progress = task.run?.progress;
  const tokens = progress?.totalTokens ?? task.usage?.totalTokens;
  const tools = progress?.toolCallCount ?? task.usage?.toolUses;
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const parts: string[] = [];
  if (typeof tokens === 'number') {
    parts.push(
      t('sessions.subagentTasks.tokens', '{{value}} tokens', {
        value: formatCompactNumber(tokens, locale),
      })
    );
  }
  if (typeof tools === 'number') {
    parts.push(t('sessions.subagentTasks.toolCalls', { count: tools }));
  }
  return parts.length ? parts.join(' · ') : null;
};

const STATE_LABEL_KEYS: Record<TaskState, [string, string]> = {
  pending: ['sessions.subagentTasks.statusPending', 'Pending'],
  running: ['sessions.subagentTasks.statusRunning', 'Running'],
  completed: ['sessions.subagentTasks.statusCompleted', 'Completed'],
  failed: ['sessions.subagentTasks.statusFailed', 'Failed'],
  cancelled: ['sessions.subagentTasks.statusCancelled', 'Cancelled'],
  unknown: ['sessions.subagentTasks.statusUnknown', 'Status unknown'],
};

export const stateLabel = (state: TaskState, t: TFunction): string => {
  const [key, fallback] = STATE_LABEL_KEYS[state];
  return t(key, fallback);
};

/** How long a running task has been at it, ticking once a second. */
export function LiveElapsed({ startedAtEpochSeconds }: { startedAtEpochSeconds: number }) {
  const { t } = useTranslation();
  const now = useStableNow(1000);
  const elapsed = Math.max(0, now.getTime() - startedAtEpochSeconds * 1000);
  return <>{formatDurationCompact(elapsed, getDurationUnitLabels(t))}</>;
}

export const actorOf = (task: SubagentTask, t: TFunction): string =>
  task.actor ||
  task.subagentType ||
  task.workflowName ||
  (task.taskType === 'local_bash'
    ? t('sessions.subagentTasks.bashActor', 'Bash')
    : t('sessions.subagentTasks.defaultActor', 'Task'));

export const durationOf = (task: SubagentTask): number | null =>
  typeof task.startedAtEpochSeconds === 'number' && typeof task.endedAtEpochSeconds === 'number'
    ? Math.max(0, (task.endedAtEpochSeconds - task.startedAtEpochSeconds) * 1000)
    : null;

/** A summary that only wraps the description (the synthesized "… completed") is noise. */
export const meaningfulSummaryOf = (task: SubagentTask): string | undefined => {
  const description = task.description?.trim();
  const summary = task.summary?.trim();
  return summary && (!description || !summary.includes(description)) ? summary : undefined;
};

/** The last line of prose the run wrote, without the Markdown that starts it. */
const lastLineOf = (text: string): string | null => {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.replace(/^[\s#>*\-+]+/, '').trim();
    if (line) return line;
  }
  return null;
};

/** One run step as a line: the tool's own title, the prose, or the kind of step. */
const describeStep = (item: SubagentRunItem, t: TFunction): string | null => {
  switch (item.type) {
    case 'tool_call': {
      const title = (item.title ?? '').replace(/`/g, '').trim() || item.toolName;
      return title || t('sessions.subagentTasks.usingTool', 'Using a tool');
    }
    case 'text':
      return lastLineOf(item.text);
    case 'thought':
      return t('sessions.subagentTasks.thinking', 'Thinking');
    case 'plan':
      return t('sessions.subagentTasks.planUpdated', 'Updated its plan');
    default:
      return null;
  }
};

/**
 * What a running task is doing right now, in one line, or null when the
 * provider has told us nothing past "running". A streamed run's latest step
 * says it most exactly; then the provider's own progress sentence; then the
 * tool it last reached for.
 */
export const latestActionOf = (task: SubagentTask, t: TFunction): string | null => {
  if (!isRunning(task)) return null;
  const items = task.run?.items ?? [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    const step = item ? describeStep(item, t) : null;
    if (step) return step;
  }
  const progress = task.run?.progress;
  const summary = progress?.summary?.trim() || meaningfulSummaryOf(task);
  if (summary) return summary;
  const tool = progress?.lastToolName || task.lastToolName;
  return tool ? t('sessions.subagentTasks.runningTool', 'Running {{tool}}', { tool }) : null;
};
