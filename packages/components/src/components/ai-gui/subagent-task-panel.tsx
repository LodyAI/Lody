import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Ban, Check, ChevronRight, CircleDashed, CircleHelp, X } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { Dialog } from '@/ui/dialog';
import { DEFAULT_CONVERSATION_FONT_SIZE, type ConversationFontSize } from '@/atoms/settings';
import { formatDurationCompact, getDurationUnitLabels } from '@/lib/format-duration';
import { withClassName } from '@/lib/stylex';
import { styles } from './subagent-task-panel.stylex';
import { dialogLayout, styles as detailStyles } from './subagent-task-detail.stylex';
import { SubagentTaskDetail } from './subagent-task-detail';
import {
  actorOf,
  durationOf,
  isRunning,
  latestActionOf,
  LiveElapsed,
  orderAsTree,
  stateLabel,
  stateOf,
  type SubagentTask,
  type TaskState,
} from './subagent-task-state';

export { collectSubagentTasks, latestActionOf, type SubagentTask } from './subagent-task-state';

const SCROLLBAR = 'scrollbar-pro';
// A body portal sits outside a mobile drawer's scroll lock and drag boundary.
const drawerOf = (node: HTMLElement | null): HTMLElement | null =>
  node?.closest<HTMLElement>('[data-vaul-drawer]') ?? null;

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

export const SubagentTaskPanel = ({
  tasks,
  onCancel,
  runCancellation = false,
  renderHistory,
  fontSize = DEFAULT_CONVERSATION_FONT_SIZE,
}: {
  tasks: readonly SubagentTask[];
  fontSize?: ConversationFontSize;
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
  // Opening focuses the transcript itself, not its first control: focusing the
  // brief's Copy button scrolled a running task back to the top, away from the
  // latest step. From there the arrow keys scroll the run.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [drawer, setDrawer] = useState<HTMLElement | null>(null);
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
    setDrawer(drawerOf(panelRef.current));
    setShownTaskId(taskId);
    setOpen(true);
  };

  return (
    <div ref={panelRef} {...stylex.props(styles.panel)}>
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
        <div {...withClassName(stylex.props(styles.rows), SCROLLBAR)}>
          {ordered.map(({ task, depth }, index) => (
            <div key={task.taskId} {...stylex.props(index > 0 && styles.rowRuled)}>
              <SubagentTaskRow task={task} depth={depth} onOpen={openTask} />
            </div>
          ))}
        </div>
      ) : null}
      <Dialog.Root open={open && shownTask !== null} onOpenChange={setOpen}>
        <Dialog.Content
          style={dialogLayout}
          initialFocus={scrollerRef}
          closeLabel={t('common.close', 'Close')}
          data-subagent-task-dialog=""
          data-vaul-no-drag=""
          container={drawer ?? undefined}
          backdropContent={
            drawer ? (
              <div data-vaul-no-drag="" {...stylex.props(detailStyles.backdropNoDrag)} />
            ) : undefined
          }
        >
          {shownTask ? (
            <SubagentTaskDetail
              key={shownTask.taskId}
              task={shownTask}
              onCancel={onCancel}
              runCancellation={runCancellation}
              scrollerRef={scrollerRef}
              renderHistory={renderHistory}
              fontSize={fontSize}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
};
