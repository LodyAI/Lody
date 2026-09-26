import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import * as stylex from '@stylexjs/stylex';
import { Ban, Check, ChevronRight, CircleDashed, CircleHelp, Copy, X } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, focus, radius, space } from '@lody/ui/tokens/scales.stylex';
import type { MessageContent } from '@lody/shared';
import { formatDurationCompact, getDurationUnitLabels } from '@/lib/format-duration';
import { writeTextToClipboard } from '@/lib/clipboard';
import { formatCompactNumber } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { useStableNow } from '@/hooks/use-stable-now';

/**
 * The subagent and background tasks a turn spawned, as one group of the turn's
 * process rather than each lifecycle event leaking into the transcript.
 *
 * Tasks are persisted as first-class `subagent_task` history items (merged by
 * `taskId`); this is a pure view-layer aggregation — it reads those items off
 * the assistant entry and never mutates persisted history.
 *
 * A task is read at two depths. Its row says what it is, what it is doing right
 * now and how long it has been at it — enough to follow while waiting, without
 * opening anything. Clicking the row opens the task at full depth in a dialog:
 * the whole brief, every step of its own run the host has received, the result
 * or error, what it cost, and Cancel for a subagent. The panel owns ONE dialog
 * and points it at a task id, so a run that is still streaming keeps updating
 * inside it.
 */

export type SubagentTask = Extract<MessageContent, { type: 'subagent_task' }>;
type SubagentRunItem = NonNullable<SubagentTask['run']>['items'][number];

/**
 * A task's state. A task carrying a normalized run reads its snapshot, which
 * can say cancelled or unknown; a legacy task has only the four-state status.
 */
type TaskState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

const stateOf = (task: SubagentTask): TaskState => {
  if (task.run) return task.run.snapshot.state;
  return task.status === 'in_progress' ? 'running' : task.status;
};

/**
 * Still worth waiting on. `unknown` is not: Lody lost sight of the run, and a
 * group that said "Waiting on" it would wait forever.
 */
const isRunning = (task: SubagentTask): boolean => {
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
const orderAsTree = (tasks: readonly SubagentTask[]) => {
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
const useUsageLabel = (task: SubagentTask): string | null => {
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

const stateLabel = (state: TaskState, t: TFunction): string => {
  const [key, fallback] = STATE_LABEL_KEYS[state];
  return t(key, fallback);
};

const STATE_LABEL_KEYS: Record<TaskState, [string, string]> = {
  pending: ['sessions.subagentTasks.statusPending', 'Pending'],
  running: ['sessions.subagentTasks.statusRunning', 'Running'],
  completed: ['sessions.subagentTasks.statusCompleted', 'Completed'],
  failed: ['sessions.subagentTasks.statusFailed', 'Failed'],
  cancelled: ['sessions.subagentTasks.statusCancelled', 'Cancelled'],
  unknown: ['sessions.subagentTasks.statusUnknown', 'Status unknown'],
};

const REGION = `color-mix(in oklab, transparent, ${colors.label} 5%)`;
/** The leading column every line of the group shares: a state mark, 14px. */
const MARK = '14px';
const MARK_GAP = space[1.5];
const MONO = 'var(--font-mono, ui-monospace, monospace)';
/** A task at full depth reads as a column of transcript: wider than the default panel. */
const DIALOG_WIDTH = '640px';
/** How close to the end of the run a reader must be for new steps to keep them there. */
const FOLLOW_SLACK_PX = 24;

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

  /**
   * One task, the width of the card. Its first line is its identity and its
   * time; a running task adds a second line under the name for what it is doing
   * now, so the step can change every few seconds without the name, the time or
   * the rows below it moving sideways.
   */
  row: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    minWidth: 0,
    margin: 0,
    paddingInlineStart: '4px',
    paddingInlineEnd: '4px',
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
  line: {
    display: 'flex',
    alignItems: 'center',
    gap: MARK_GAP,
    width: '100%',
    minWidth: 0,
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
    marginInlineStart: 'auto',
    color: colors.tertiaryLabel,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  /** The step in flight, hung under the name rather than under the mark. */
  latest: {
    minWidth: 0,
    paddingInlineStart: `calc(${MARK} + ${MARK_GAP})`,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.95em',
    color: colors.tertiaryLabel,
  },
  /** A run another run started hangs under its parent's name. */
  depth1: { paddingInlineStart: `calc(4px + ${MARK} + ${MARK_GAP})` },
  depth2: { paddingInlineStart: `calc(4px + 2 * (${MARK} + ${MARK_GAP}))` },
  danger: { color: colors.destructive },

  /** The task at full depth; everything under the heading scrolls as one column. */
  detail: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
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
  section: { display: 'flex', flexDirection: 'column', gap: space[1], minWidth: 0 },
  sectionLabel: { margin: 0, fontSize: '11px', color: colors.tertiaryLabel },
  sectionText: {
    margin: 0,
    fontSize: '12.5px',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    color: colors.label,
  },
  /** The run's steps read as the conversation's own timeline does. */
  history: { display: 'flex', flexDirection: 'column', gap: space[1], minWidth: 0 },
  note: {
    margin: 0,
    fontSize: '12.5px',
    lineHeight: 1.5,
    color: colors.secondaryLabel,
  },
  actionsError: { flexGrow: 1, alignSelf: 'center' },
});

/** How long a running task has been at it, ticking once a second. */
function LiveElapsed({ startedAtEpochSeconds }: { startedAtEpochSeconds: number }) {
  const { t } = useTranslation();
  const now = useStableNow(1000);
  const elapsed = Math.max(0, now.getTime() - startedAtEpochSeconds * 1000);
  return <>{formatDurationCompact(elapsed, getDurationUnitLabels(t))}</>;
}

const actorOf = (task: SubagentTask, t: TFunction): string =>
  task.actor ||
  task.subagentType ||
  task.workflowName ||
  (task.taskType === 'local_bash'
    ? t('sessions.subagentTasks.bashActor', 'Bash')
    : t('sessions.subagentTasks.defaultActor', 'Task'));

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

const SETTLED_TONE: Partial<Record<TaskState, 'danger' | 'muted'>> = {
  failed: 'danger',
  cancelled: 'muted',
  unknown: 'muted',
};

function SubagentTaskRow({
  task,
  depth,
  onOpen,
}: {
  task: SubagentTask;
  depth: number;
  onOpen: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const actor = actorOf(task, t);
  const state = stateOf(task);
  const running = isRunning(task);
  const duration = durationOf(task);
  const latest = latestActionOf(task, t);
  const tone = SETTLED_TONE[state];

  // The trailing word answers the question a reader has of a task in that state:
  // how long so far, how long it took, or how it ended when that was not well.
  // What it is doing is the second line's job, so the time never gives way to a
  // tool name.
  const meta = running ? (
    typeof task.startedAtEpochSeconds === 'number' ? (
      <LiveElapsed startedAtEpochSeconds={task.startedAtEpochSeconds} />
    ) : null
  ) : tone ? (
    stateLabel(state, t)
  ) : duration !== null ? (
    formatDurationCompact(duration, getDurationUnitLabels(t))
  ) : null;

  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={task.description ? `${actor} · ${task.description}` : actor}
      data-subagent-task-id={task.taskId}
      onClick={() => onOpen(task.taskId)}
      {...stylex.props(styles.row, depth === 1 && styles.depth1, depth >= 2 && styles.depth2)}
    >
      <span {...stylex.props(styles.line)}>
        <TaskMark state={state} />
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
          <span {...stylex.props(styles.meta, tone === 'danger' && styles.danger)}>{meta}</span>
        ) : null}
      </span>
      {latest ? (
        <span data-subagent-latest-action="" {...stylex.props(styles.latest)}>
          {latest}
        </span>
      ) : null}
    </button>
  );
}

/** A task's state as a mark: live, done, failed, stopped, lost, or not started. */
function TaskMark({ state }: { state: TaskState }) {
  if (state === 'running') {
    return (
      <span {...stylex.props(styles.mark)}>
        <Spinner size="small" />
      </span>
    );
  }
  const [Glyph, tone] =
    state === 'completed'
      ? [Check, styles.markDone]
      : state === 'failed'
        ? [X, styles.markFailed]
        : state === 'cancelled'
          ? [Ban, styles.markPending]
          : state === 'unknown'
            ? [CircleHelp, styles.markPending]
            : [CircleDashed, styles.markPending];
  return (
    <span aria-hidden="true" {...stylex.props(styles.mark, tone)}>
      <Glyph {...stylex.props(styles.glyph)} />
    </span>
  );
}

/** The brief, whole, with one-tap copy. A background command reads as code. */
function TaskBrief({ task, body }: { task: SubagentTask; body: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const isCommand = task.taskType === 'local_bash';
  const BriefElement = isCommand ? 'pre' : 'div';
  return (
    <div {...stylex.props(styles.bodyWrap)}>
      {/* A command is code and keeps `pre`; a brief is prose, and the page's
          base `pre` rule would set it in the code face whatever StyleX says. */}
      <BriefElement
        aria-label={
          isCommand
            ? t('sessions.subagentTasks.command', 'Command')
            : t('sessions.subagentTasks.description', 'Description')
        }
        {...stylex.props(styles.body, isCommand && styles.bodyMono)}
      >
        {body}
      </BriefElement>
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
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} {...stylex.props(styles.section)}>
      <p aria-hidden="true" {...stylex.props(styles.sectionLabel)}>
        {label}
      </p>
      {children}
    </section>
  );
}

/**
 * The run's own steps, or why there are none. A provider that streams nothing
 * is said to, so a quiet run never reads as a broken stream; a run that lost
 * steps on the way says so under whatever did arrive.
 */
function TaskActivity({
  task,
  renderHistory,
}: {
  task: SubagentTask;
  renderHistory?: (task: SubagentTask) => ReactNode;
}) {
  const { t } = useTranslation();
  const run = task.run;
  if (!run) return null;
  const hasSteps = run.items.length > 0;
  const streams = run.snapshot.support.stream.length > 0;
  const emptyNote = hasSteps
    ? null
    : !streams
      ? t(
          'sessions.subagentTasks.activityNotStreamed',
          'This agent reports its status and result, not its individual steps.'
        )
      : isRunning(task)
        ? t('sessions.subagentTasks.activityWaiting', 'Waiting for the first step…')
        : t('sessions.subagentTasks.activityNone', 'No steps were received.');
  return (
    <Section label={t('sessions.subagentTasks.activity', 'Activity')}>
      {hasSteps && renderHistory ? (
        <div data-subagent-run-history="" {...stylex.props(styles.history)}>
          {renderHistory(task)}
        </div>
      ) : null}
      {emptyNote ? <p {...stylex.props(styles.note)}>{emptyNote}</p> : null}
      {run.snapshot.outputIncomplete ? (
        <p {...stylex.props(styles.note)}>
          {t(
            'sessions.subagentTasks.activityIncomplete',
            'Some steps of this run were not received.'
          )}
        </p>
      ) : null}
    </Section>
  );
}

function CancelTaskAction({
  task,
  onCancel,
}: {
  task: SubagentTask;
  onCancel: (taskId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  return (
    <>
      {cancelError ? (
        <p role="alert" {...stylex.props(styles.sectionText, styles.danger, styles.actionsError)}>
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
              await onCancel(task.taskId);
            } catch (cause) {
              setCancelError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setCancelling(false);
            }
          })();
        }}
      >
        {cancelling ? <Spinner size="small" /> : null}
        {t('sessions.subagentTasks.stop', 'Stop task')}
      </Button>
    </>
  );
}

/**
 * Keeps a scroller pinned to its end while the reader is there, and leaves it
 * alone once they scroll up to read. A running task opens at its latest step; a
 * finished one opens at its brief.
 */
function useFollowEnd(follow: boolean, content: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(follow);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [content]);
  const onScroll = () => {
    const node = ref.current;
    if (!node) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK_PX;
  };
  return { ref, onScroll };
}

/** The task at full depth: what it is, the whole brief, its run, its result, its cost. */
function TaskDetail({
  task,
  onCancel,
  runCancellation,
  renderHistory,
}: {
  task: SubagentTask;
  onCancel?: (taskId: string) => Promise<void>;
  runCancellation: boolean;
  renderHistory?: (task: SubagentTask) => ReactNode;
}) {
  const { t } = useTranslation();
  const actor = actorOf(task, t);
  const state = stateOf(task);
  const running = isRunning(task);
  const body = task.description?.trim();
  const result = meaningfulSummaryOf(task);
  const duration = durationOf(task);
  const usage = useUsageLabel(task);
  const latest = latestActionOf(task, t);
  // Cancel is offered only where the run says it can be and the machine can
  // address a run: never a fallback to stopping the parent turn.
  const canCancel =
    Boolean(onCancel) &&
    running &&
    task.taskKind === 'subagent' &&
    (task.run ? runCancellation && task.run.snapshot.support.cancel : true);
  const { ref, onScroll } = useFollowEnd(running, task);

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>{actor}</Dialog.Title>
        <Dialog.Description>
          {stateLabel(state, t)}
          {running && typeof task.startedAtEpochSeconds === 'number' ? (
            <>
              {' · '}
              <LiveElapsed startedAtEpochSeconds={task.startedAtEpochSeconds} />
            </>
          ) : duration !== null ? (
            ` · ${formatDurationCompact(duration, getDurationUnitLabels(t))}`
          ) : null}
          {usage ? ` · ${usage}` : null}
          {task.run?.snapshot.modelId ? ` · ${task.run.snapshot.modelId}` : null}
        </Dialog.Description>
      </Dialog.Header>

      <div ref={ref} onScroll={onScroll} {...stylex.props(styles.detail)}>
        {body ? (
          <Section
            label={
              task.taskType === 'local_bash'
                ? t('sessions.subagentTasks.command', 'Command')
                : t('sessions.subagentTasks.brief', 'Brief')
            }
          >
            <TaskBrief task={task} body={body} />
          </Section>
        ) : null}

        <TaskActivity task={task} renderHistory={renderHistory} />

        {/* A legacy task has no steps; the one line the row shows is all it has. */}
        {!task.run && latest ? (
          <Section label={t('sessions.subagentTasks.latestAction', 'Latest')}>
            <p {...stylex.props(styles.sectionText)}>{latest}</p>
          </Section>
        ) : null}

        {state === 'unknown' ? (
          <p {...stylex.props(styles.note)}>
            {t(
              'sessions.subagentTasks.unknownExplanation',
              'Lody lost track of this run. It may still be running, or may have stopped.'
            )}
          </p>
        ) : null}

        {(state === 'failed' || state === 'cancelled' || state === 'unknown') && task.error ? (
          <Section label={t('sessions.subagentTasks.error', 'Error')}>
            <p {...stylex.props(styles.sectionText, state === 'failed' && styles.danger)}>
              {task.error}
            </p>
          </Section>
        ) : null}

        {!running && result ? (
          <Section label={t('sessions.subagentTasks.result', 'Result')}>
            <p {...stylex.props(styles.sectionText)}>{result}</p>
          </Section>
        ) : null}
      </div>

      {canCancel && onCancel ? (
        <Dialog.Footer>
          <CancelTaskAction task={task} onCancel={onCancel} />
        </Dialog.Footer>
      ) : null}
    </>
  );
}

export const SubagentTaskPanel = ({
  tasks,
  onCancel,
  runCancellation = false,
  renderHistory,
}: {
  tasks: readonly SubagentTask[];
  onCancel?: (taskId: string) => Promise<void>;
  /**
   * The machine speaks subagent events v1, so a cancel can address a run.
   * Stored run history shows whatever this says; only the live control waits on it.
   */
  runCancellation?: boolean;
  /**
   * The steps of a task's own run (`task.run.items`), for its detail dialog.
   * The host owns the transcript renderers; the panel only places them.
   */
  renderHistory?: (task: SubagentTask) => ReactNode;
}) => {
  const { t } = useTranslation();
  const ordered = useMemo(() => orderAsTree(tasks), [tasks]);
  const runningCount = useMemo(() => tasks.filter(isRunning).length, [tasks]);
  const hasRunning = runningCount > 0;
  const [userExpanded, setUserExpanded] = useState(false);
  // One dialog for the group, pointed at a task id rather than a snapshot, so
  // an open dialog follows the run as its item is replaced in history.
  const [open, setOpen] = useState(false);
  // The dialog keeps the last task it showed while it animates closed.
  const [shownTaskId, setShownTaskId] = useState<string | null>(null);
  const shownTask = tasks.find((task) => task.taskId === shownTaskId) ?? null;

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

  const openTask = (taskId: string) => {
    setShownTaskId(taskId);
    setOpen(true);
  };

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
          {ordered.map(({ task, depth }, index) => (
            <div key={task.taskId} {...stylex.props(index > 0 && styles.rowRuled)}>
              <SubagentTaskRow task={task} depth={depth} onOpen={openTask} />
            </div>
          ))}
        </div>
      ) : null}
      <Dialog.Root open={open && shownTask !== null} onOpenChange={setOpen}>
        <Dialog.Content
          style={{ width: DIALOG_WIDTH }}
          closeLabel={t('common.close', 'Close')}
          data-subagent-task-dialog=""
        >
          {shownTask ? (
            <TaskDetail
              key={shownTask.taskId}
              task={shownTask}
              onCancel={onCancel}
              runCancellation={runCancellation}
              renderHistory={renderHistory}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
};
