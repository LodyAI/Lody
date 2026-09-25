import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Check, ChevronRight, CircleDashed, Copy, X } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, focus, radius, space } from '@lody/ui/tokens/scales.stylex';
import type { MessageContent } from '@lody/shared';
import { formatDurationCompact } from '@/lib/format-duration';
import { writeTextToClipboard } from '@/lib/clipboard';
import { useStableNow } from '@/hooks/use-stable-now';

/**
 * The subagent and background tasks a turn spawned, as one group of the turn's
 * process rather than each lifecycle event leaking into the transcript.
 *
 * Tasks are persisted as first-class `subagent_task` history items (merged by
 * `taskId`); this is a pure view-layer aggregation — it reads those items off
 * the assistant entry and never mutates persisted history.
 *
 * A task is read at two depths. Its row says what it is and how long it has
 * been at it — enough to follow while waiting. Clicking the row PEEKS at the
 * rest in a popover anchored to it: the full command or brief, the result or
 * error, what it cost, and Cancel for a subagent. A task has no live output to
 * show, so it never takes a dialog, and it never unfolds in place either: that
 * would push the turn around for a few lines of detail.
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

const STATUS_LABEL_KEYS: Record<SubagentTask['status'], [string, string]> = {
  pending: ['sessions.subagentTasks.statusPending', 'Pending'],
  in_progress: ['sessions.subagentTasks.statusRunning', 'Running'],
  completed: ['sessions.subagentTasks.statusCompleted', 'Completed'],
  failed: ['sessions.subagentTasks.statusFailed', 'Failed'],
};

const REGION = `color-mix(in oklab, transparent, ${colors.label} 5%)`;
/** The leading column every line of the group shares: a state mark, 14px. */
const MARK = '14px';
const MARK_GAP = space[1.5];
const MONO = 'var(--font-mono, ui-monospace, monospace)';

const styles = stylex.create({
  /**
   * The group is a card of its own: tasks run beside the turn rather than as
   * one of its steps, and a reader waiting on them needs one place to look.
   */
  panel: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingInline: space[1.5],
    paddingBlock: space[1],
    backgroundColor: `color-mix(in oklab, ${colors.elevatedBackground} 55%, transparent)`,
    boxShadow: `inset 0 0 0 1px ${colors.separator}`,
    borderRadius: radius.large,
    cornerShape: corner.shape,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: MARK_GAP,
    width: '100%',
    margin: 0,
    paddingInline: '4px',
    paddingBlock: '3px',
    borderWidth: 0,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    fontSize: '0.9em',
    lineHeight: 1.5,
    textAlign: 'start',
    userSelect: 'none',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    cursor: 'default',
    outlineStyle: 'none',
  },
  headerToggle: { cursor: 'pointer' },
  chevron: {
    width: '14px',
    height: '14px',
    flexShrink: 0,
    transitionProperty: 'transform',
    transitionDuration: '150ms',
  },
  chevronOpen: { transform: 'rotate(90deg)' },
  glyph: { width: '14px', height: '14px', flexShrink: 0 },
  /**
   * Every line starts with a mark in one column, so a finished task does not
   * sit a spinner's width to the left of a running one, and the header's mark
   * says whether the group is still live.
   */
  mark: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: MARK,
    height: MARK,
  },
  markDone: { color: colors.success },
  markFailed: { color: colors.destructive },
  markPending: { color: colors.tertiaryLabel },
  /** The tasks, ruled apart; a long run scrolls inside the card. */
  rows: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '22rem',
    overflowY: 'auto',
    marginTop: '2px',
  },
  rowRuled: { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: colors.separator },

  /** One task, the width of the card: its state, what it is, and its time at the end. */
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: MARK_GAP,
    width: '100%',
    minWidth: 0,
    margin: 0,
    paddingInline: '4px',
    paddingBlock: '4px',
    borderWidth: 0,
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    fontFamily: 'inherit',
    fontSize: '0.9em',
    lineHeight: 1.5,
    textAlign: 'start',
    userSelect: 'none',
    color: colors.secondaryLabel,
    cursor: 'pointer',
    outlineStyle: 'none',
    boxShadow: {
      default: 'none',
      ':focus-visible': `inset 0 0 0 ${focus.ringWidth} ${colors.accent}`,
    },
    transitionProperty: 'background-color',
    transitionDuration: '120ms',
  },
  actor: {
    flexShrink: 0,
    color: { default: colors.label, ':hover': colors.label },
  },
  description: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  dot: { flexShrink: 0, color: colors.tertiaryLabel },
  meta: {
    flexShrink: 0,
    color: colors.tertiaryLabel,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  danger: { color: colors.destructive },

  /** The peek: the task at full depth, anchored to its row. */
  peek: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    width: 'min(440px, calc(100vw - 32px))',
  },
  peekHead: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  peekTitle: {
    margin: 0,
    fontSize: '13px',
    fontWeight: 600,
    lineHeight: 1.35,
    color: colors.label,
  },
  peekMeta: {
    margin: 0,
    fontSize: '12px',
    lineHeight: 1.4,
    color: colors.secondaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  bodyWrap: { position: 'relative', minWidth: 0 },
  body: {
    maxHeight: '240px',
    overflowY: 'auto',
    margin: 0,
    paddingBlock: space[2],
    paddingInlineStart: space[3],
    // Room for the copy button in the corner.
    paddingInlineEnd: '36px',
    backgroundColor: REGION,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontSize: '12px',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    color: colors.label,
  },
  bodyMono: { fontFamily: MONO },
  copy: { position: 'absolute', insetBlockStart: '4px', insetInlineEnd: '4px' },
  section: { display: 'flex', flexDirection: 'column', gap: space[1] },
  sectionLabel: { margin: 0, fontSize: '11px', color: colors.tertiaryLabel },
  sectionText: {
    margin: 0,
    fontSize: '12.5px',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    color: colors.label,
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: space[2] },
});

const durationLabels = (t: (key: string, fallback: string) => string) => ({
  hour: t('time.unitShort.hour', 'h'),
  minute: t('time.unitShort.minute', 'm'),
  second: t('time.unitShort.second', 's'),
});

/** How long a running task has been at it, ticking once a second. */
function LiveElapsed({ startedAtEpochSeconds }: { startedAtEpochSeconds: number }) {
  const { t } = useTranslation();
  const now = useStableNow(1000);
  const elapsed = Math.max(0, now.getTime() - startedAtEpochSeconds * 1000);
  return <>{formatDurationCompact(elapsed, durationLabels(t))}</>;
}

const useActor = (task: SubagentTask): string => {
  const { t } = useTranslation();
  return (
    task.actor ||
    task.subagentType ||
    task.workflowName ||
    (task.taskType === 'local_bash'
      ? t('sessions.subagentTasks.bashActor', 'Bash')
      : t('sessions.subagentTasks.defaultActor', 'Task'))
  );
};

const durationOf = (task: SubagentTask): number | null =>
  typeof task.startedAtEpochSeconds === 'number' && typeof task.endedAtEpochSeconds === 'number'
    ? Math.max(0, (task.endedAtEpochSeconds - task.startedAtEpochSeconds) * 1000)
    : null;

/** A summary that only wraps the description (the synthesized "… completed") is noise. */
const meaningfulSummaryOf = (task: SubagentTask): string | undefined => {
  const description = task.description?.trim();
  const summary = task.summary?.trim();
  return summary && (!description || !summary.includes(description)) ? summary : undefined;
};

function SubagentTaskRow({
  task,
  onCancel,
}: {
  task: SubagentTask;
  onCancel?: (taskId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const actor = useActor(task);
  const running = isRunning(task);
  const duration = durationOf(task);

  // The trailing word answers the question a reader has of a task in that state:
  // how long so far, what it is doing, how long it took, or that it failed.
  const meta = running ? (
    task.lastToolName ? (
      t('sessions.subagentTasks.runningTool', 'Running {{tool}}', { tool: task.lastToolName })
    ) : typeof task.startedAtEpochSeconds === 'number' ? (
      <LiveElapsed startedAtEpochSeconds={task.startedAtEpochSeconds} />
    ) : null
  ) : task.status === 'failed' ? (
    t('sessions.subagentTasks.statusFailed', 'Failed')
  ) : duration !== null ? (
    formatDurationCompact(duration, durationLabels(t))
  ) : null;

  return (
    <Popover.Root>
      <Popover.Trigger
        render={<button type="button" {...stylex.props(styles.row)} />}
        aria-label={task.description ? `${actor} · ${task.description}` : actor}
      >
        <TaskMark status={task.status} />
        <span {...stylex.props(styles.actor)}>{actor}</span>
        {task.description ? (
          <>
            <span aria-hidden="true" {...stylex.props(styles.dot)}>
              ·
            </span>
            <span {...stylex.props(styles.description)}>{task.description}</span>
          </>
        ) : null}
        {meta ? (
          <span {...stylex.props(styles.meta, task.status === 'failed' && styles.danger)}>
            {meta}
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Content side="bottom" align="start">
        <TaskPeek task={task} actor={actor} onCancel={onCancel} />
      </Popover.Content>
    </Popover.Root>
  );
}

/** A task's state as a mark: live, done, failed, or not started. */
function TaskMark({ status }: { status: SubagentTask['status'] }) {
  if (status === 'in_progress') {
    return (
      <span {...stylex.props(styles.mark)}>
        <Spinner size="small" />
      </span>
    );
  }
  const [Glyph, tone] =
    status === 'completed'
      ? [Check, styles.markDone]
      : status === 'failed'
        ? [X, styles.markFailed]
        : [CircleDashed, styles.markPending];
  return (
    <span aria-hidden="true" {...stylex.props(styles.mark, tone)}>
      <Glyph {...stylex.props(styles.glyph)} />
    </span>
  );
}

/** The task at full depth: what it is, the whole brief, its result, its cost. */
function TaskPeek({
  task,
  actor,
  onCancel,
}: {
  task: SubagentTask;
  actor: string;
  onCancel?: (taskId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  const running = isRunning(task);
  const isCommand = task.taskType === 'local_bash';
  const body = task.description?.trim();
  const result = meaningfulSummaryOf(task);
  const duration = durationOf(task);
  const [statusKey, statusFallback] = STATUS_LABEL_KEYS[task.status];
  const canCancel = Boolean(onCancel) && running && task.taskKind === 'subagent';

  return (
    <div {...stylex.props(styles.peek)}>
      <div {...stylex.props(styles.peekHead)}>
        <p {...stylex.props(styles.peekTitle)}>{actor}</p>
        <p {...stylex.props(styles.peekMeta, task.status === 'failed' && styles.danger)}>
          {t(statusKey, statusFallback)}
          {running && typeof task.startedAtEpochSeconds === 'number' ? (
            <>
              {' · '}
              <LiveElapsed startedAtEpochSeconds={task.startedAtEpochSeconds} />
            </>
          ) : duration !== null ? (
            ` · ${formatDurationCompact(duration, durationLabels(t))}`
          ) : null}
          {running && task.lastToolName
            ? ` · ${t('sessions.subagentTasks.runningTool', 'Running {{tool}}', {
                tool: task.lastToolName,
              })}`
            : null}
          {formatUsage(task.usage) ? ` · ${formatUsage(task.usage)}` : null}
        </p>
      </div>

      {body ? (
        <div {...stylex.props(styles.bodyWrap)}>
          <pre
            aria-label={
              isCommand
                ? t('sessions.subagentTasks.command', 'Command')
                : t('sessions.subagentTasks.description', 'Description')
            }
            {...stylex.props(styles.body, isCommand && styles.bodyMono)}
          >
            {body}
          </pre>
          <span {...stylex.props(styles.copy)}>
            <Button
              type="button"
              variant="ghost"
              size="mini"
              icon
              aria-label={copied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}
              onClick={() => {
                void writeTextToClipboard(body).then((ok) => {
                  if (ok) setCopied(true);
                });
              }}
            >
              {copied ? (
                <Check {...stylex.props(styles.glyph)} />
              ) : (
                <Copy {...stylex.props(styles.glyph)} />
              )}
            </Button>
          </span>
        </div>
      ) : null}

      {task.status === 'failed' && task.error ? (
        <div {...stylex.props(styles.section)}>
          <p {...stylex.props(styles.sectionLabel)}>{t('sessions.subagentTasks.error', 'Error')}</p>
          <p {...stylex.props(styles.sectionText, styles.danger)}>{task.error}</p>
        </div>
      ) : null}

      {result ? (
        <div {...stylex.props(styles.section)}>
          <p {...stylex.props(styles.sectionLabel)}>
            {t('sessions.subagentTasks.result', 'Result')}
          </p>
          <p {...stylex.props(styles.sectionText)}>{result}</p>
        </div>
      ) : null}

      {canCancel ? (
        <div {...stylex.props(styles.actions)}>
          {cancelError ? (
            <p role="alert" {...stylex.props(styles.sectionText, styles.danger)}>
              {cancelError}
            </p>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={cancelling}
            onClick={() => {
              void (async () => {
                setCancelling(true);
                setCancelError(undefined);
                try {
                  await onCancel?.(task.taskId);
                } catch (cause) {
                  setCancelError(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setCancelling(false);
                }
              })();
            }}
          >
            {cancelling ? <Spinner size="small" /> : null}
            {t('sessions.subagentTasks.cancelNamed', {
              name: task.description || actor,
              defaultValue: 'Cancel {{name}}',
            })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

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

  // While work is in flight the group stays open (live status). Once every task
  // has settled it folds to its summary line, which opens it again.
  const expanded = hasRunning || userExpanded;
  const canToggle = !hasRunning;

  // Background-ness is stated once in the summary rather than badged per row.
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
    <div {...stylex.props(styles.panel)}>
      <button
        type="button"
        {...stylex.props(styles.header, canToggle && styles.headerToggle)}
        onClick={canToggle ? () => setUserExpanded((prev) => !prev) : undefined}
        aria-expanded={canToggle ? expanded : undefined}
      >
        <span {...stylex.props(styles.mark)}>
          {canToggle ? (
            <ChevronRight
              aria-hidden="true"
              {...stylex.props(styles.chevron, expanded && styles.chevronOpen)}
            />
          ) : (
            <Spinner size="small" />
          )}
        </span>
        <span>
          {headerLabel}
          {mixedBackgroundLabel ? ` · ${mixedBackgroundLabel}` : null}
        </span>
      </button>
      {expanded ? (
        <div {...stylex.props(styles.rows)}>
          {tasks.map((task, index) => (
            <div key={task.taskId} {...stylex.props(index > 0 && styles.rowRuled)}>
              <SubagentTaskRow task={task} onCancel={onCancel} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};
