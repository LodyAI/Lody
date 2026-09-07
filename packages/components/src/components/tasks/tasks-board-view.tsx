import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  closestCorners,
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle,
  Bot,
  FolderGit2,
  GitPullRequest,
  MessagesSquare,
  Plus,
  User,
} from 'lucide-react';
import { TASK_STATUS_VALUES, type TaskIndexRow, type TaskStatus } from '@lody/shared';
import type { TaskCardProperty } from '@/atoms/tasks';
import { getTaskPriorityPresentation } from './task-priority-presentation';
import { taskLabelPillStyle } from './task-label-presentation';
import {
  applyTaskBoardDragOver,
  buildTaskBoardColumns,
  parseTaskBoardColumnDropId,
  resolveTaskBoardMoveFromPreview,
  taskBoardColumnDropId,
  type TaskBoardColumns,
  type TaskBoardMove,
} from './task-board-move';
import { resolveBoardWheelScroll } from './task-board-wheel';
import { cn } from '@/lib/utils';
import { CachedAvatarImg } from '@/components/cached-avatar-img';
import { formatShortMonthYear } from '@/lib/format-relative-time';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { FocusScope, useListKeyboardNavigation } from '@/ui/focus-scope';
import { getTaskStatusPresentation, TASK_STATUS_PRESENTATION } from './task-status-presentation';

export type { TaskBoardMove };

export type TaskCardData = TaskIndexRow & {
  /** Resolved display name for `agentConfigId`; absent when it cannot be resolved. */
  agentName?: string;
  /** Resolved display name for the project; absent when it cannot be resolved. */
  projectName?: string;
  /** A linked session is waiting on the user. Derived, never stored on the task. */
  needsYou?: boolean;
  ownerName?: string;
  /** Owner's avatar URL, for the list layout's trailing identity column. */
  ownerImage?: string | null;
  /** Place in its agent's queue; 1 means next up. Absent when not waiting a turn. */
  queuePosition?: number;
  /** A comment mentions you and you have not opened the thread since. */
  unreadMention?: boolean;
};

export type TasksBoardViewProps = {
  tasks: readonly TaskCardData[];
  /** Properties this view draws beyond the title. Order is fixed, not this list's. */
  visibleProperties?: readonly TaskCardProperty[];
  onOpenTask: (taskId: string) => void;
  /** Receives the column the button was pressed in, so the task starts there. */
  onQuickAdd: (status?: TaskStatus) => void;
  /**
   * Board layout only. Same-column reorder or cross-column status+order move.
   * Omit (or leave undefined) to disable dragging — list layout never drags.
   */
  onMove?: (move: TaskBoardMove) => void;
  /** Rendered as a flat grouped list instead of columns. */
  layout?: 'board' | 'list';
};

const groupByStatus = (
  tasks: readonly TaskCardData[]
): { status: TaskStatus; tasks: TaskCardData[] }[] =>
  TASK_STATUS_PRESENTATION.map((entry) => ({
    status: entry.status,
    tasks: tasks.filter((task) => task.status === entry.status),
  }));

/**
 * Opt-in mid-row chips (labels + agent only). Priority sits left of the title;
 * project sits on the footer next to the owner — keeping those out of this row
 * so they never fight for the same slot.
 *
 * FIXED height, never wrapping: toggling a property on or off must not change
 * how tall the row is.
 */
function TaskPropertyChips({
  task,
  visible,
  className,
}: {
  task: TaskCardData;
  visible: readonly TaskCardProperty[];
  className?: string;
}) {
  const labels = visible.includes('labels') ? (task.labels ?? []) : [];
  const agentName = visible.includes('agent') ? task.agentName : undefined;
  if (labels.length === 0 && !agentName) return null;

  return (
    <div className={cn('flex h-5 min-w-0 items-center gap-1 overflow-hidden', className)}>
      {labels.map((label) => (
        <span
          key={label}
          // Same derived color as the properties rail and the label picker, so
          // one label reads the same everywhere it appears.
          style={taskLabelPillStyle(label)}
          className="shrink-0 rounded border px-1.5 text-[10px] leading-4"
        >
          {label}
        </span>
      ))}
      {agentName ? (
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <Bot className="h-3 w-3 shrink-0" />
          <span className="truncate">{agentName}</span>
        </span>
      ) : null}
    </div>
  );
}

function TaskPriorityIcon({
  task,
  visible,
  className,
}: {
  task: TaskCardData;
  visible: readonly TaskCardProperty[];
  className?: string;
}) {
  if (!visible.includes('priority') || !task.priority) return null;
  const presentation = getTaskPriorityPresentation(task.priority);
  return (
    <presentation.Icon
      className={cn('h-3.5 w-3.5 shrink-0', presentation.className, className)}
      aria-hidden
    />
  );
}

function TaskProjectName({
  task,
  visible,
  className,
}: {
  task: TaskCardData;
  visible: readonly TaskCardProperty[];
  className?: string;
}) {
  if (!visible.includes('project') || !task.projectName) return null;
  return (
    <span
      className={cn(
        'flex min-w-0 max-w-[50%] items-center gap-1 text-[11px] text-muted-foreground',
        className
      )}
    >
      <FolderGit2 className="h-3 w-3 shrink-0" />
      <span className="truncate">{task.projectName}</span>
    </span>
  );
}

function TaskCard({
  task,
  onOpen,
  visibleProperties,
  sortable,
  dragEnabled = false,
}: {
  task: TaskCardData;
  onOpen: () => void;
  visibleProperties: readonly TaskCardProperty[];
  /** When set, the card is a dnd-kit sortable (board only). */
  sortable?: ReturnType<typeof useSortable>;
  dragEnabled?: boolean;
}) {
  const { t } = useTranslation();
  const hasCounts = (task.sessionCount ?? 0) > 0 || (task.prCount ?? 0) > 0;
  const showProject = visibleProperties.includes('project') && Boolean(task.projectName);
  const showFooter = hasCounts || Boolean(task.ownerName) || showProject;
  const style = sortable
    ? {
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }
    : undefined;

  return (
    <button
      type="button"
      data-id={`task:${task.taskId}`}
      data-scope-item="row"
      ref={sortable?.setNodeRef}
      style={style}
      onClick={onOpen}
      className={cn(
        'group flex w-full flex-col gap-2 rounded-lg border border-border/70 bg-card p-3 text-left',
        'shadow-[0_1px_2px_rgb(15_23_42/0.03)] dark:shadow-[0_1px_2px_rgb(0_0_0/0.35)] transition-colors hover:border-border',
        dragEnabled && 'touch-none cursor-grab active:cursor-grabbing',
        // While DragOverlay carries the floating card, the source slot stays
        // as a dim placeholder so column layout still shows the drop gap.
        sortable?.isDragging && 'opacity-30'
      )}
      {...(dragEnabled && sortable ? { ...sortable.attributes, ...sortable.listeners } : {})}
    >
      <div className="flex items-start gap-2">
        <TaskPriorityIcon task={task} visible={visibleProperties} className="mt-0.5" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {task.title || t('tasks.untitled', 'Untitled task')}
        </span>
        {task.unreadMention ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 rounded bg-status-info/15 px-1.5 py-0.5 text-[10px] font-medium text-status-info">
                {t('tasks.mentionedYou', 'Mentioned you')}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t('tasks.mentionedYouHint', 'A comment mentions you. Open the task to read it.')}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {task.needsYou ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 rounded bg-status-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-status-warning">
                {t('tasks.needsYou', 'Needs you')}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t('tasks.needsYouHint', 'An agent is waiting for your answer')}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {task.queuePosition !== undefined ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 rounded bg-muted-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {t('tasks.queued', '#{{position}} in queue', { position: task.queuePosition })}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t(
                'tasks.queuedHint',
                'Its agent works on one task at a time, in the order you put them in.'
              )}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {task.hasAgent &&
        (task.status === 'backlog' || task.status === 'todo') &&
        task.ready === false ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warning" />
            </TooltipTrigger>
            <TooltipContent>
              {t(
                'tasks.incompleteHint',
                'This task is assigned to an agent but is missing a project, so it cannot run yet.'
              )}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <TaskPropertyChips task={task} visible={visibleProperties} />

      {showFooter ? (
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
            {task.ownerName ? (
              <span className="flex min-w-0 items-center gap-1">
                <User className="h-3 w-3 shrink-0" />
                <span className="truncate">{task.ownerName}</span>
              </span>
            ) : null}
            {(task.sessionCount ?? 0) > 0 ? (
              <span className="flex shrink-0 items-center gap-1">
                <MessagesSquare className="h-3 w-3" />
                {task.sessionCount}
              </span>
            ) : null}
            {(task.prCount ?? 0) > 0 ? (
              <span className="flex shrink-0 items-center gap-1">
                <GitPullRequest className="h-3 w-3" />
                {task.prCount}
              </span>
            ) : null}
          </div>
          <TaskProjectName task={task} visible={visibleProperties} className="ml-auto shrink-0" />
        </div>
      ) : null}
    </button>
  );
}

/**
 * Board is the desktop default because it shows the shape of the work at a
 * glance; the list is the compact form for narrow screens.
 *
 * Column membership is the task's declared status. Live execution facts are not
 * columns — they surface on the card (needs-you) and on the task page, where the
 * linked sessions and PRs draw their own state.
 */

/**
 * One task as a single fixed-height line, for the list layout.
 *
 * Every row is the same height regardless of what it carries — that is the
 * point of a list rather than a stack of cards: the eye scans a straight column
 * of titles, and the trailing metadata lines up into columns of its own. So
 * nothing here wraps or grows: the title truncates, and the badges, owner and
 * date are all fixed-width and `shrink-0`.
 */
function TaskListRow({
  task,
  onOpen,
  visibleProperties,
}: {
  task: TaskCardData;
  onOpen: () => void;
  visibleProperties: readonly TaskCardProperty[];
}) {
  const { t } = useTranslation();
  const presentation = getTaskStatusPresentation(task.status);
  const ownerLabel = task.ownerName ?? '';
  const ownerUnassigned = !task.ownerId;

  return (
    <button
      type="button"
      data-id={`task:${task.taskId}`}
      data-scope-item="row"
      onClick={onOpen}
      className={cn(
        'group flex h-9 w-full items-center gap-2 rounded-md px-3 text-left',
        'transition-colors hover:bg-muted-foreground/[0.06]'
      )}
    >
      <presentation.Icon className={cn('h-3.5 w-3.5 shrink-0', presentation.className)} />
      <TaskPriorityIcon task={task} visible={visibleProperties} />
      <span className="min-w-0 flex-1 truncate text-sm">
        {task.title || t('tasks.untitled', 'Untitled task')}
      </span>

      {/* Mid-row chips only (labels + agent). Priority is left of the title;
         project sits with the owner on the trailing side. */}
      <TaskPropertyChips task={task} visible={visibleProperties} className="shrink-0" />

      {task.unreadMention ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          </TooltipTrigger>
          <TooltipContent>{t('tasks.unreadMention', 'A comment mentions you')}</TooltipContent>
        </Tooltip>
      ) : null}
      {task.needsYou ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 rounded bg-status-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-status-warning">
              {t('tasks.needsYou', 'Needs you')}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {t('tasks.needsYouHint', 'An agent is waiting for your answer')}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {task.queuePosition !== undefined ? (
        <span className="shrink-0 rounded bg-muted-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {t('tasks.queued', '#{{position}} in queue', { position: task.queuePosition })}
        </span>
      ) : null}
      {task.hasAgent &&
      (task.status === 'backlog' || task.status === 'todo') &&
      task.ready === false ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-status-warning" />
          </TooltipTrigger>
          <TooltipContent>
            {t(
              'tasks.incompleteHint',
              'This task is assigned to an agent but is missing a project, so it cannot run yet.'
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}

      {(task.sessionCount ?? 0) > 0 ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <MessagesSquare className="h-3 w-3" />
          {task.sessionCount}
        </span>
      ) : null}
      {(task.prCount ?? 0) > 0 ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <GitPullRequest className="h-3 w-3" />
          {task.prCount}
        </span>
      ) : null}

      {/* Owner: avatar when we have one, initial when we only have a name, and a
         neutral glyph when the id could not be resolved to a member at all
         (someone who left the workspace, or members still loading). */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            {task.ownerImage ? (
              <CachedAvatarImg
                src={task.ownerImage}
                alt=""
                loading="lazy"
                className="h-5 w-5 rounded-full object-cover"
              />
            ) : ownerLabel ? (
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted-foreground/15 text-[10px] font-medium uppercase text-muted-foreground">
                {ownerLabel.slice(0, 1)}
              </span>
            ) : (
              <User className="h-3.5 w-3.5 text-muted-foreground/50" />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {ownerLabel
            ? ownerLabel
            : ownerUnassigned
              ? t('tasks.ownerUnassigned', 'No owner')
              : t('tasks.ownerUnknown', 'Owner unknown')}
        </TooltipContent>
      </Tooltip>

      <TaskProjectName task={task} visible={visibleProperties} className="max-w-[8rem] shrink-0" />

      <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {formatShortMonthYear(task.createdAt)}
      </span>
    </button>
  );
}

/**
 * Per-column create affordance. Present in every column, including populated
 * ones, so "add a task in this state" is always one click and the new task
 * starts in the column you pointed at.
 *
 * Two shapes for two layouts: the desktop Kanban board puts it inline in the
 * header row, beside the column title — a small icon button, not its own row,
 * so it reads as part of the column's title bar the same way "Todo" and
 * "In Progress" do. The mobile/narrow list stacks sections vertically instead
 * of side by side, where a full-width dashed row at the end of each section
 * reads better than a header-corner icon would.
 */
function ColumnAddButton({
  status,
  onQuickAdd,
  label,
  variant = 'row',
}: {
  status: TaskStatus;
  onQuickAdd: (status: TaskStatus) => void;
  label: string;
  variant?: 'row' | 'inline';
}) {
  if (variant === 'inline') {
    return (
      <button
        type="button"
        onClick={() => onQuickAdd(status)}
        aria-label={label}
        title={label}
        className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-muted-foreground/10 hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onQuickAdd(status)}
      aria-label={label}
      title={label}
      className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border/60 py-1.5 text-xs text-muted-foreground transition hover:border-border hover:bg-muted-foreground/5 hover:text-foreground"
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * Group header for list layout: status icon + label + inline add. No count
 * badge (the rows under the header are the count). Sticky so the status stays
 * visible while scrolling a long group.
 *
 * Surface uses a *relative* mix of foreground into the canvas — not
 * `bg-muted`. In Vesper (and several other dark themes) that token resolves
 * to the same hex as `--background`, so a muted wash is invisible. Mixing
 * toward foreground always produces a readable step. No border: grouping is
 * the wash + rounded bar + list gap; rows stay divider-free.
 */
function ListGroupHeader({
  status,
  onQuickAdd,
}: {
  status: TaskStatus;
  onQuickAdd: (status: TaskStatus) => void;
}) {
  const { t } = useTranslation();
  const presentation = getTaskStatusPresentation(status);
  return (
    <header
      className="sticky top-0 z-[1] flex h-8 items-center gap-2 rounded-md px-3 backdrop-blur-sm"
      style={{
        backgroundColor:
          'color-mix(in oklab, hsl(var(--background)) 88%, hsl(var(--foreground)) 12%)',
      }}
    >
      <presentation.Icon className={cn('h-3.5 w-3.5 shrink-0', presentation.className)} />
      <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground">
        {t(presentation.labelKey, presentation.labelFallback)}
      </h2>
      <ColumnAddButton
        status={status}
        onQuickAdd={onQuickAdd}
        label={t('tasks.addToColumn', 'Add task')}
        variant="inline"
      />
    </header>
  );
}

function SortableTaskCard({
  task,
  columnStatus,
  onOpen,
  visibleProperties,
  disabled,
}: {
  task: TaskCardData;
  /** Column the card is rendered in (may differ from task.status during preview). */
  columnStatus: TaskStatus;
  onOpen: () => void;
  visibleProperties: readonly TaskCardProperty[];
  disabled: boolean;
}) {
  const sortable = useSortable({
    id: task.taskId,
    data: { type: 'task' as const, status: columnStatus },
    disabled,
  });
  return (
    <TaskCard
      task={task}
      onOpen={onOpen}
      visibleProperties={visibleProperties}
      // Always attach the node so SortableContext stays consistent; listeners
      // only attach while drag is enabled.
      sortable={sortable}
      dragEnabled={!disabled}
    />
  );
}

function BoardColumn({
  status,
  tasks,
  onOpenTask,
  onQuickAdd,
  visibleProperties,
  canDrag,
  isDropTarget,
}: {
  status: TaskStatus;
  tasks: readonly TaskCardData[];
  onOpenTask: (taskId: string) => void;
  onQuickAdd: (status: TaskStatus) => void;
  visibleProperties: readonly TaskCardProperty[];
  canDrag: boolean;
  /** Column under the pointer during a cross-column drag. */
  isDropTarget: boolean;
}) {
  const { t } = useTranslation();
  const scopeId = useId();
  useListKeyboardNavigation({ scopeId });
  const presentation = getTaskStatusPresentation(status);
  const { setNodeRef, isOver } = useDroppable({
    id: taskBoardColumnDropId(status),
    data: { type: 'column' as const, status },
  });
  const itemIds = tasks.map((task) => task.taskId);
  const highlight = isOver || isDropTarget;

  return (
    <FocusScope
      id={scopeId}
      role="region"
      aria-label={t(presentation.labelKey, presentation.labelFallback)}
      data-task-board-column=""
      className="flex h-full w-72 shrink-0 flex-col gap-2"
    >
      <header className="flex shrink-0 items-center gap-2 px-1">
        <presentation.Icon className={cn('h-3.5 w-3.5', presentation.className)} />
        <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground">
          {t(presentation.labelKey, presentation.labelFallback)}
        </h2>
        <ColumnAddButton
          status={status}
          onQuickAdd={onQuickAdd}
          label={t('tasks.addToColumn', 'Add task')}
          variant="inline"
        />
      </header>
      {/* Columns stretch to the board's full height and scroll their own cards
         independently. The droppable wraps the scroll body so empty columns
         still accept drops. */}
      <div
        ref={setNodeRef}
        className={cn(
          'scrollbar-pro flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-md pr-0.5 transition-colors',
          highlight && 'bg-muted-foreground/[0.07] ring-1 ring-inset ring-border/70'
        )}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <SortableTaskCard
              key={task.taskId}
              task={task}
              columnStatus={status}
              onOpen={() => onOpenTask(task.taskId)}
              visibleProperties={visibleProperties}
              disabled={!canDrag}
            />
          ))}
        </SortableContext>
      </div>
    </FocusScope>
  );
}

/** True when the wheel target sits inside a column, up to (excluding) the board. */
function isInsideBoardColumn(target: EventTarget | null, boundary: HTMLElement): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== boundary) {
    if (node instanceof HTMLElement && node.dataset.taskBoardColumn != null) return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * Lets a plain mouse wheel move the board sideways (see `task-board-wheel.ts`
 * for when the delta is ours to take).
 *
 * Deliberately a native listener rather than an `onWheel` prop: React registers
 * `wheel` at the root as a *passive* listener, so `preventDefault()` from a
 * synthetic handler is ignored and only logs a console error. Without it the
 * browser would still run its own default for the same event.
 */
function useBoardWheelScroll(enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const board = ref.current;
    if (!enabled || !board) return undefined;
    const handleWheel = (event: WheelEvent) => {
      const delta = resolveBoardWheelScroll({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        insideColumn: isInsideBoardColumn(event.target, board),
        board,
      });
      if (delta === null) return;
      event.preventDefault();
      board.scrollLeft += delta;
    };
    board.addEventListener('wheel', handleWheel, { passive: false });
    return () => board.removeEventListener('wheel', handleWheel);
  }, [enabled]);
  return ref;
}

export function TasksBoardView({
  tasks,
  onOpenTask,
  onQuickAdd,
  onMove,
  layout = 'board',
  visibleProperties = [],
}: TasksBoardViewProps) {
  const groups = groupByStatus(tasks);
  // List only: empty status sections are noise (a long page of empty headers).
  // Board always shows every column — the kanban shape is the empty state and
  // each column's `+` is how you create into that status.
  const listGroups = groups.filter((group) => group.tasks.length > 0);
  const canDrag = layout === 'board' && Boolean(onMove);
  // After a real drag, the browser may still fire click — swallow that open.
  const suppressOpenRef = useRef(false);
  const boardRef = useBoardWheelScroll(layout === 'board');
  const listScopeId = useId();
  useListKeyboardNavigation({ enabled: layout === 'list', scopeId: listScopeId });

  const tasksById = useMemo(() => {
    const map = new Map<string, TaskCardData>();
    for (const task of tasks) map.set(task.taskId, task);
    return map;
  }, [tasks]);

  // Authoritative column layout from props (manual order).
  const sourceColumns = useMemo(() => buildTaskBoardColumns(tasks), [tasks]);
  // Live layout while dragging — cards hop into the target column under the pointer.
  const [previewColumns, setPreviewColumns] = useState<TaskBoardColumns | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const startColumnsRef = useRef<TaskBoardColumns | null>(null);
  // Ref mirrors preview synchronously so onDragEnd does not read a stale React
  // state snapshot from before the last onDragOver setState flushed.
  const previewColumnsRef = useRef<TaskBoardColumns | null>(null);

  // If the index updates mid-drag (another client), drop the stale preview.
  useEffect(() => {
    if (activeId) return;
    setPreviewColumns(null);
    previewColumnsRef.current = null;
  }, [sourceColumns, activeId]);

  const displayColumns = previewColumns ?? sourceColumns;
  const activeTask = activeId ? (tasksById.get(activeId) ?? null) : null;
  const activeColumnStatus = useMemo(() => {
    if (!activeId || !previewColumns) return null;
    for (const status of TASK_STATUS_VALUES) {
      if (previewColumns[status].includes(activeId)) return status;
    }
    return null;
  }, [activeId, previewColumns]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Keep clicks as opens; only a real drag starts the gesture.
      activationConstraint: { distance: 8 },
    })
  );

  const handleOpenTask = useCallback(
    (taskId: string) => {
      if (suppressOpenRef.current) {
        suppressOpenRef.current = false;
        return;
      }
      onOpenTask(taskId);
    },
    [onOpenTask]
  );

  const resetDrag = useCallback(() => {
    setActiveId(null);
    setPreviewColumns(null);
    previewColumnsRef.current = null;
    startColumnsRef.current = null;
  }, []);

  const pointerInsertAfter = (event: {
    active: { rect: { current: { translated?: { top: number; height: number } | null } } };
    over: { id: unknown; rect: { top: number; height: number } } | null;
  }): boolean => {
    const over = event.over;
    const translated = event.active.rect.current.translated;
    if (!over || !translated) return false;
    // Column droppables have no "lower half of a card".
    if (parseTaskBoardColumnDropId(String(over.id))) return false;
    const midY = over.rect.top + over.rect.height / 2;
    return translated.top + translated.height / 2 > midY;
  };

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = String(event.active.id);
      setActiveId(id);
      startColumnsRef.current = sourceColumns;
      previewColumnsRef.current = sourceColumns;
      setPreviewColumns(sourceColumns);
    },
    [sourceColumns]
  );

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const draggedId = String(active.id);
    const overId = String(over.id);
    const insertAfterOver = pointerInsertAfter(event);

    setPreviewColumns((current) => {
      const base = current ?? startColumnsRef.current;
      if (!base) return current;
      const next = applyTaskBoardDragOver({
        columns: base,
        activeId: draggedId,
        overId,
        insertAfterOver,
      });
      if (!next) return current;
      previewColumnsRef.current = next;
      return next;
    });
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over, delta } = event;
      if (Math.abs(delta.x) > 2 || Math.abs(delta.y) > 2) {
        suppressOpenRef.current = true;
      }

      const start = startColumnsRef.current;
      const taskId = String(active.id);

      // Final placement from the ref (always up to date) and the terminal `over`,
      // so we never commit a position from a stale React render.
      let preview = previewColumnsRef.current;
      if (start && over) {
        const base = preview ?? start;
        const finalized = applyTaskBoardDragOver({
          columns: base,
          activeId: taskId,
          overId: String(over.id),
          insertAfterOver: pointerInsertAfter(event),
        });
        if (finalized) preview = finalized;
      }

      resetDrag();

      if (!onMove || !start || !preview) return;

      const move = resolveTaskBoardMoveFromPreview({
        startColumns: start,
        previewColumns: preview,
        taskId,
      });
      if (move) onMove(move);
    },
    [onMove, resetDrag]
  );

  const handleDragCancel = useCallback(() => {
    resetDrag();
  }, [resetDrag]);

  if (layout === 'list') {
    // Horizontal inset matches the board's breathing room (`p-4` there) and
    // the inbox strip above — without it, rounded group headers would flush
    // against the pane edge (and a right-only margin looks broken).
    return (
      <FocusScope id={listScopeId} role="region" className="flex w-full flex-col gap-3 px-3 py-3">
        {listGroups.map((group) => (
          // 2px between header↔rows and row↔row so hover washes don't fuse;
          // larger gap-3 between status sections keeps groups distinct.
          <section key={group.status} className="flex w-full flex-col gap-0.5">
            <ListGroupHeader status={group.status} onQuickAdd={onQuickAdd} />
            {group.tasks.map((task) => (
              <TaskListRow
                key={task.taskId}
                task={task}
                onOpen={() => onOpenTask(task.taskId)}
                visibleProperties={visibleProperties}
              />
            ))}
          </section>
        ))}
      </FocusScope>
    );
  }

  return (
    // `h-full min-h-0` is load-bearing: the parent flex column only passes a
    // height budget down if this root claims it. Without that the board shrinks
    // to content height and the horizontal scrollbar sits mid-page under the
    // shortest column instead of at the viewport bottom.
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div
        ref={boardRef}
        className="scrollbar-pro flex h-full min-h-0 gap-4 overflow-x-auto overflow-y-hidden p-4"
      >
        {TASK_STATUS_VALUES.map((status) => {
          const ids = displayColumns[status];
          const columnTasks = ids
            .map((id) => tasksById.get(id))
            .filter((task): task is TaskCardData => Boolean(task));
          return (
            <BoardColumn
              key={status}
              status={status}
              tasks={columnTasks}
              onOpenTask={handleOpenTask}
              onQuickAdd={onQuickAdd}
              visibleProperties={visibleProperties}
              canDrag={canDrag}
              isDropTarget={activeColumnStatus === status && Boolean(activeId)}
            />
          );
        })}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <div className="w-72 rotate-[1.5deg] scale-[1.02] cursor-grabbing shadow-xl">
            <TaskCard
              task={activeTask}
              onOpen={() => {}}
              visibleProperties={visibleProperties}
              dragEnabled={false}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
