import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatTaskNumber, useAcceptCoordinatorTasks, useProjectBoardData } from './project-board';
import type {
  CoordinatorProjectKey,
  ProjectBoardBucket,
  ProjectBoardRow,
} from './project-board-model';

/**
 * Project mode: the coordinator's conversation shows people what changed, not
 * the machinery. Receipts and creation cards collapse into one "changes" line
 * whose task states come from the tasks themselves, and every open item sits
 * in one to-do card at the end of the conversation.
 *
 * Presentation only: history, model input and receipts are untouched, so the
 * full rows are one click away and copy/export still see everything.
 */
type CoordinatorConversationValue = {
  tasks: ReadonlyMap<string, ProjectBoardRow>;
  todo: readonly ProjectBoardRow[];
  openTask: (sessionId: string) => void;
  acceptTasks: (sessionIds: readonly string[]) => void;
  /**
   * Starts a reply about a task: puts the task's session mention in the
   * coordinator's composer, so the message names its conversation exactly.
   */
  replyToTask: (sessionId: string) => void;
};

const CoordinatorConversationContext = createContext<CoordinatorConversationValue | null>(null);

/** `null` outside a project coordinator's own conversation. */
export const useCoordinatorConversation = (): CoordinatorConversationValue | null =>
  useContext(CoordinatorConversationContext);

export function CoordinatorConversationProvider({
  coordinatorSessionId,
  project,
  onOpenTask,
  onReplyToTask,
  children,
}: {
  coordinatorSessionId: string;
  project: CoordinatorProjectKey | null;
  onOpenTask: (sessionId: string) => void;
  onReplyToTask: (sessionId: string) => void;
  children: ReactNode;
}) {
  const board = useProjectBoardData(coordinatorSessionId, project);
  const acceptTasks = useAcceptCoordinatorTasks();
  const value = useMemo<CoordinatorConversationValue>(() => {
    const tasks = new Map<string, ProjectBoardRow>();
    for (const rows of Object.values(board)) {
      for (const row of rows) tasks.set(row.session.id, row);
    }
    return {
      tasks,
      // What needs the user first, then what waits for review.
      todo: [...board.needsYou, ...board.review],
      openTask: onOpenTask,
      acceptTasks,
      replyToTask: onReplyToTask,
    };
  }, [acceptTasks, board, onOpenTask, onReplyToTask]);
  return (
    <CoordinatorConversationContext.Provider value={value}>
      {children}
    </CoordinatorConversationContext.Provider>
  );
}

export type { CoordinatorConversationValue };

/** Supplies the value directly, for stories that render without a workspace. */
export function CoordinatorConversationPreviewProvider({
  value,
  children,
}: {
  value: CoordinatorConversationValue;
  children: ReactNode;
}) {
  return (
    <CoordinatorConversationContext.Provider value={value}>
      {children}
    </CoordinatorConversationContext.Provider>
  );
}

const STATE_LABELS: Record<ProjectBoardBucket, [key: string, fallback: string]> = {
  needsYou: ['projectMode.board.needsYou', 'Needs you'],
  working: ['projectMode.board.working', 'In progress'],
  review: ['projectMode.board.review', 'To review'],
  accepted: ['projectMode.board.accepted', 'Accepted'],
};

const styles = stylex.create({
  strip: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    minWidth: 0,
  },
  stripHead: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: colors.secondaryLabel,
  },
  stripLabel: { flexShrink: 0 },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    maxWidth: 320,
    minWidth: 0,
    paddingBlock: 2,
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: colors.wellBackground, ':hover': colors.hoverFill },
    color: colors.label,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    cursor: 'pointer',
  },
  chipNumber: { fontVariantNumeric: 'tabular-nums', color: colors.secondaryLabel },
  chipTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  state: { flexShrink: 0, fontSize: text.footnoteSize, lineHeight: text.footnoteLeading },
  stateneedsYou: { color: colors.warning },
  stateworking: { color: colors.accent },
  statereview: { color: colors.label },
  stateaccepted: { color: colors.success },
  disclosure: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.tertiaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    cursor: 'pointer',
  },
  todo: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    marginBlock: space[3],
    borderRadius: radius.large,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
  },
  todoHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    paddingBlock: space[2],
    paddingInline: space[3],
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    color: colors.label,
  },
  todoCount: { marginInlineStart: space[1.5], fontWeight: 400, color: colors.secondaryLabel },
  todoRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingBlock: space[2],
    paddingInline: space[3],
    boxShadow: `inset 0 0.5px 0 ${colors.separator}`,
  },
  todoMain: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    flexGrow: 1,
    minWidth: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.label,
    textAlign: 'start',
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    cursor: 'pointer',
  },
  todoMore: {
    paddingBlock: space[2],
    paddingInline: space[3],
    borderWidth: 0,
    backgroundColor: 'transparent',
    boxShadow: `inset 0 0.5px 0 ${colors.separator}`,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    textAlign: 'start',
    cursor: 'pointer',
  },
});

function TaskState({ bucket }: { bucket: ProjectBoardBucket }) {
  const { t } = useTranslation();
  const [key, fallback] = STATE_LABELS[bucket];
  return <span {...stylex.props(styles.state, styles[`state${bucket}`])}>{t(key, fallback)}</span>;
}

/**
 * One line in place of a receipt or creation row: the tasks it touched, each
 * with its state now. The original row opens beneath on request.
 */
export function CoordinatorTaskChangeStrip({
  sessionIds,
  fallbackTitles,
  details,
}: {
  sessionIds: readonly string[];
  /** Titles carried by the row, for tasks not on the board (archived, someone else's). */
  fallbackTitles: ReadonlyMap<string, string>;
  details: ReactNode;
}) {
  const { t } = useTranslation();
  const coordinator = useCoordinatorConversation();
  const [expanded, setExpanded] = useState(false);
  if (!coordinator) return <>{details}</>;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div {...stylex.props(styles.strip)} data-coordinator-change-strip="">
      <div {...stylex.props(styles.stripHead)}>
        <span {...stylex.props(styles.stripLabel)}>
          {t('projectMode.changes.label', 'Changes')}
        </span>
        {sessionIds.map((id) => {
          const task = coordinator.tasks.get(id);
          const title =
            task?.session.title?.trim() ||
            fallbackTitles.get(id) ||
            t('sessions.untitled', 'Untitled session');
          const number = formatTaskNumber(task?.taskNumber ?? null);
          return (
            <button
              key={id}
              type="button"
              title={title}
              onClick={() => coordinator.openTask(id)}
              {...stylex.props(styles.chip)}
            >
              {number ? <span {...stylex.props(styles.chipNumber)}>{number}</span> : null}
              <span {...stylex.props(styles.chipTitle)}>{title}</span>
              {task ? <TaskState bucket={task.bucket} /> : null}
            </button>
          );
        })}
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          {...stylex.props(styles.disclosure)}
        >
          {t('projectMode.changes.details', 'Details')}
          <Chevron size={12} aria-hidden="true" />
        </button>
      </div>
      {expanded ? details : null}
    </div>
  );
}

const TODO_VISIBLE_ROWS = 5;

/**
 * Everything waiting on the user, at the end of the coordinator's conversation:
 * questions, permission requests and failed sends first, then finished tasks to
 * review. Hidden when nothing waits.
 */
export function CoordinatorTodoCard() {
  const { t } = useTranslation();
  const coordinator = useCoordinatorConversation();
  const [showAll, setShowAll] = useState(false);
  const acceptOne = useCallback((id: string) => coordinator?.acceptTasks([id]), [coordinator]);
  if (!coordinator || coordinator.todo.length === 0) return null;
  const { todo } = coordinator;
  const visible = showAll ? todo : todo.slice(0, TODO_VISIBLE_ROWS);
  const reviewIds = todo.filter((row) => row.bucket === 'review').map((row) => row.session.id);
  return (
    <section {...stylex.props(styles.todo)} data-testid="coordinator-todo">
      <div {...stylex.props(styles.todoHead)}>
        <span>
          {t('projectMode.todo.title', 'To do')}
          <span {...stylex.props(styles.todoCount)}>{todo.length}</span>
        </span>
        {reviewIds.length > 1 ? (
          <Button size="small" variant="ghost" onClick={() => coordinator.acceptTasks(reviewIds)}>
            {t('projectMode.board.acceptAll', 'Accept all')}
          </Button>
        ) : null}
      </div>
      {visible.map((row) => {
        const number = formatTaskNumber(row.taskNumber);
        const title = row.session.title?.trim() || t('sessions.untitled', 'Untitled session');
        return (
          <div key={row.session.id} {...stylex.props(styles.todoRow)}>
            <button
              type="button"
              title={title}
              onClick={() => coordinator.openTask(row.session.id)}
              {...stylex.props(styles.todoMain)}
            >
              {number ? <span {...stylex.props(styles.chipNumber)}>{number}</span> : null}
              <span {...stylex.props(styles.chipTitle)}>{title}</span>
              <TaskState bucket={row.bucket} />
            </button>
            <Button
              size="small"
              variant="ghost"
              onClick={() => coordinator.replyToTask(row.session.id)}
            >
              {t('projectMode.todo.reply', 'Reply')}
            </Button>
            {row.bucket === 'review' ? (
              <Button size="small" variant="secondary" onClick={() => acceptOne(row.session.id)}>
                {t('projectMode.board.accept', 'Accept')}
              </Button>
            ) : (
              <Button
                size="small"
                variant="secondary"
                onClick={() => coordinator.openTask(row.session.id)}
              >
                {t('projectMode.todo.open', 'Open')}
              </Button>
            )}
          </div>
        );
      })}
      {todo.length > TODO_VISIBLE_ROWS ? (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          {...stylex.props(styles.todoMore)}
        >
          {showAll
            ? t('projectMode.todo.showLess', 'Show less')
            : t('projectMode.todo.showMore', '{{count}} more', {
                count: todo.length - TODO_VISIBLE_ROWS,
              })}
        </button>
      ) : null}
    </section>
  );
}
