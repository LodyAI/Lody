import { useCallback, useEffect, useMemo } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useParams, useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Check, LayoutGrid, List, ListFilter, ListTodo, Plus } from 'lucide-react';
import { atomWithStorage } from 'jotai/utils';
import { atom } from 'jotai';
import {
  computeTaskQueuePositions,
  generateTaskOrderKeyBetween,
  hasUnreadTaskMention,
  type TaskId,
  type TaskStatus,
} from '@lody/shared';
import { currentWorkspaceSlugAtom, userAtom } from '@/atoms';
import {
  closeTaskTabAtom,
  openTaskTabAtom,
  openTaskTabsAtom,
  taskInboxAtom,
  taskIndexRowsAtom,
  taskListAtom,
  taskQuickAddOpenAtom,
  taskQuickAddStatusAtom,
  taskThreadReadAtAtom,
} from '@/atoms/tasks';
import { TaskInboxPanel } from './task-inbox-panel';
import { useStableNow } from '@/hooks/use-stable-now';
import { useIsMobile } from '@/hooks/use-mobile';
import { useOrganization } from '@/hooks/useOrganization';
import { useTaskActions } from '@/hooks/use-task-actions';
import { useTaskSessionRollups } from '@/hooks/use-task-session-rollup';
import { Button } from '@lody/ui/button';
import { ScrollArea } from '@/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import {
  TASK_CARD_PROPERTIES,
  taskVisiblePropertiesAtom,
  type TaskCardProperty,
  type TaskVisibleProperties,
} from '@/atoms/tasks';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { useVisibleLocalProjects } from '@/hooks/use-visible-local-projects';
import { BaseHeader } from '@/components/page-headers/base-header';
import { TasksBoardView, type TaskCardData } from './tasks-board-view';
import type { TaskBoardMove } from './task-board-move';
import { TaskTabBar } from './task-tab-bar';
import { TaskDetailActionsMenu } from './task-detail-actions-menu';
import { TaskDetailView } from './task-detail-view';
import { TASK_DETAIL_ROUTE_ID } from './task-routes';
import { TASKS_SURFACE_CLASS, tasksMenuClassName, tasksMenuSurfaceStyle } from './tasks-surface';
import { cn } from '@/lib/utils';

type TasksLayout = 'board' | 'list';

const tasksLayoutAtom = atomWithStorage<TasksLayout>('lody-tasks-layout', 'board');

/**
 * Mobile-only filter for "just what is blocked on me". Off by default and not
 * persisted: a filtered-by-default phone screen shows nothing when nothing needs
 * you, which reads as "no tasks" rather than "filtered".
 */
const mobileNeedsYouOnlyAtom = atom(false);

/**
 * Desktop Tasks shell: a pinned "All Tasks" home tab plus a detail tab for each
 * opened task. URL is the source of truth for the *active* tab
 * (`/tasks` vs `/tasks/$taskId`); open-tab membership lives in
 * `openTaskTabsAtom` so closing a tab and reopening from the list is cheap.
 *
 * Mobile keeps the prior stack: list page or full detail, no multi-tab chrome
 * (browser-tab metaphors belong to desktop).
 */
/** Fixed order and wording for the Show toggles. */
const TASK_CARD_PROPERTY_LABELS: Record<TaskCardProperty, { key: string; fallback: string }> = {
  priority: { key: 'tasks.properties.priority', fallback: 'Priority' },
  labels: { key: 'tasks.properties.labels', fallback: 'Labels' },
  project: { key: 'tasks.slots.project', fallback: 'Project' },
  agent: { key: 'tasks.slots.agent', fallback: 'Agent' },
};

export function TasksWorkspace() {
  const isMobile = useIsMobile();
  // Prefer the detail-route params over `strict: false` so a bookmarked
  // `/tasks/$taskId` always yields the id when that route is matched, and
  // yields nothing on the All Tasks index (where the param does not exist).
  const taskParams = useParams({ from: TASK_DETAIL_ROUTE_ID, shouldThrow: false });
  const activeTaskId = (taskParams?.taskId as TaskId | undefined) ?? null;
  const openTab = useSetAtom(openTaskTabAtom);

  // Deep-link or list click: ensure the active task is among the open tabs.
  useEffect(() => {
    if (activeTaskId) {
      openTab(activeTaskId);
    }
  }, [activeTaskId, openTab]);

  if (isMobile) {
    return activeTaskId ? <TaskDetailView /> : <TasksListBody mobile />;
  }

  return <DesktopTasksWorkspace activeTaskId={activeTaskId} />;
}

function DesktopTasksWorkspace({ activeTaskId }: { activeTaskId: TaskId | null }) {
  const { t } = useTranslation();
  const router = useRouter();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const openTabs = useAtomValue(openTaskTabsAtom);
  const tasks = useAtomValue(taskListAtom);
  const closeTab = useSetAtom(closeTaskTabAtom);
  const layout = useAtomValue(tasksLayoutAtom);
  const [visibleByView, setVisibleByView] = useAtom(taskVisiblePropertiesAtom);
  const visibleProperties = visibleByView[layout] ?? [];
  const toggleProperty = useCallback(
    (property: TaskCardProperty) => {
      setVisibleByView((previous: TaskVisibleProperties) => {
        const current = previous[layout] ?? [];
        const next = current.includes(property)
          ? current.filter((item: TaskCardProperty) => item !== property)
          : [...current, property];
        return { ...previous, [layout]: next };
      });
    },
    [layout, setVisibleByView]
  );
  const setLayout = useSetAtom(tasksLayoutAtom);

  const tabItems = useMemo(() => {
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    return openTabs.map((taskId) => {
      const row = byId.get(taskId);
      return {
        taskId,
        title: row?.title ?? '',
      };
    });
  }, [openTabs, tasks]);

  const navigateAll = useCallback(() => {
    if (!workspaceSlug) return;
    void router.navigate({
      to: '/$workspaceName/tasks',
      params: { workspaceName: workspaceSlug },
    });
  }, [router, workspaceSlug]);

  const navigateTask = useCallback(
    (taskId: string) => {
      if (!workspaceSlug) return;
      void router.navigate({
        to: '/$workspaceName/tasks/$taskId',
        params: { workspaceName: workspaceSlug, taskId },
      });
    },
    [router, workspaceSlug]
  );

  const handleCloseTask = useCallback(
    (taskId: string) => {
      const index = openTabs.indexOf(taskId as TaskId);
      closeTab(taskId as TaskId);
      if (activeTaskId !== taskId) {
        return;
      }
      // Closing the active tab: prefer the neighbour to the left, else All Tasks.
      const remaining = openTabs.filter((id) => id !== taskId);
      const fallback = remaining[Math.max(0, index - 1)] ?? remaining[0] ?? null;
      if (fallback && workspaceSlug) {
        void router.navigate({
          to: '/$workspaceName/tasks/$taskId',
          params: { workspaceName: workspaceSlug, taskId: fallback },
        });
      } else {
        navigateAll();
      }
    },
    [activeTaskId, closeTab, navigateAll, openTabs, router, workspaceSlug]
  );

  // All Tasks chrome only: the icon-only Filter (view menu). Creating lives on
  // the sidebar's Tasks row (`+`) and its shortcut instead — a second create
  // button here only paid off on this one page, and only after navigating to it.
  const rightSlot =
    activeTaskId === null ? (
      <>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" aria-label={t('tasks.filter.label', 'Filter')} icon>
                  <ListFilter className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('tasks.filter.label', 'Filter')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="end"
            className={tasksMenuClassName('w-48')}
            style={tasksMenuSurfaceStyle}
          >
            <DropdownMenuLabel>{t('tasks.filter.viewLabel', 'View')}</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setLayout('board')}>
              <LayoutGrid className="h-3.5 w-3.5" />
              <span className="flex-1">{t('tasks.tabs.board', 'Board')}</span>
              {layout === 'board' ? <Check className="h-3.5 w-3.5 text-foreground" /> : null}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setLayout('list')}>
              <List className="h-3.5 w-3.5" />
              <span className="flex-1">{t('tasks.tabs.list', 'List')}</span>
              {layout === 'list' ? <Check className="h-3.5 w-3.5 text-foreground" /> : null}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* Toggles, not menu items: these are a set you scan and flip
               several of, so they read as one row of small boxes rather than a
               column you arrow through one at a time. Wrapped in a plain div so
               clicking one does not dismiss the menu. */}
            <div className="px-2 pb-1.5 pt-1">
              <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                {t('tasks.show.title', 'Show')}
              </p>
              <div className="flex flex-wrap gap-1">
                {TASK_CARD_PROPERTIES.map((property) => {
                  const active = visibleProperties.includes(property);
                  return (
                    <button
                      key={property}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleProperty(property)}
                      className={cn(
                        'rounded-md border px-2 py-1 text-[11px] transition-colors',
                        active
                          ? 'border-transparent bg-muted-foreground/20 text-foreground'
                          : 'border-border/70 text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground'
                      )}
                    >
                      {t(
                        TASK_CARD_PROPERTY_LABELS[property].key,
                        TASK_CARD_PROPERTY_LABELS[property].fallback
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    ) : (
      // A task detail tab is open: the same slot carries per-task actions.
      <TaskDetailActionsMenu taskId={activeTaskId} workspaceSlug={workspaceSlug} />
    );

  return (
    <TooltipProvider>
      <div
        className={cn(
          TASKS_SURFACE_CLASS,
          'flex h-full w-full flex-1 flex-col overflow-hidden bg-background'
        )}
      >
        <TaskTabBar
          tabs={tabItems}
          activeTaskId={activeTaskId}
          onSelectAll={navigateAll}
          onSelectTask={navigateTask}
          onCloseTask={handleCloseTask}
          rightSlot={rightSlot}
        />
        {activeTaskId ? <TaskDetailView embedded /> : <TasksListBody />}
      </div>
    </TooltipProvider>
  );
}

/**
 * The All Tasks surface: inbox + board/list. Used as the home tab on desktop
 * and as the full page on mobile. Layout chrome (tabs / mobile header) lives
 * outside this body so the same content can sit under either.
 *
 * Exported for the mobile home screen, which embeds the same body as its
 * Tasks dock tab (see `mobile-home-screen.tsx`). Pass `embedded` when the
 * body sits under another page header (home dock) so we don't double
 * safe-area padding or re-draw the drawer menu.
 */
export function TasksListBody({
  mobile = false,
  embedded = false,
}: {
  mobile?: boolean;
  /** Under an outer chrome (mobile home header). Skip safe-area BaseHeader. */
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const isMobile = mobile;
  const visibleByView = useAtomValue(taskVisiblePropertiesAtom);
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom) as {
    id: string;
    name?: string;
    cliType: string;
  }[];
  const visibleLocalProjects = useVisibleLocalProjects({ includeMachineFlock: true });
  const tasks = useAtomValue(taskListAtom);
  const userId = useAtomValue(userAtom)?.id;
  const threadReadAt = useAtomValue(taskThreadReadAtAtom);
  const rollups = useTaskSessionRollups();
  const layout = useAtomValue(tasksLayoutAtom);
  // Mobile only ever has the list; the Show set must follow what is drawn.
  const effectiveLayout = isMobile ? 'list' : layout;
  const openQuickAdd = useSetAtom(taskQuickAddOpenAtom);
  const setQuickAddStatus = useSetAtom(taskQuickAddStatusAtom);
  const needsYouOnly = useAtomValue(mobileNeedsYouOnlyAtom);
  const inboxItems = useAtomValue(taskInboxAtom);
  const now = useStableNow();
  const { activeOrganization } = useOrganization();
  const setNeedsYouOnly = useSetAtom(mobileNeedsYouOnlyAtom);
  const { updateTaskFields } = useTaskActions();
  const setTaskIndexRows = useSetAtom(taskIndexRowsAtom);

  const membersByUserId = useMemo(() => {
    const map = new Map<string, { name?: string | null; image?: string | null }>();
    for (const member of activeOrganization?.members ?? []) {
      map.set(member.userId, {
        name: member.user?.name ?? member.user?.email ?? null,
        image: member.user?.image ?? null,
      });
    }
    return map;
  }, [activeOrganization?.members]);

  const handleQuickAdd = useCallback(
    (status?: TaskStatus) => {
      setQuickAddStatus(status ?? null);
      openQuickAdd(true);
    },
    [openQuickAdd, setQuickAddStatus]
  );

  // Names for the ids the index row carries. Both lists are already loaded for
  // other surfaces, so this resolves without a new query; an id that resolves to
  // nothing renders nothing rather than leaking the raw id onto a card.
  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const config of agentConfigs) {
      map.set(config.id as string, config.name || config.cliType);
    }
    return map;
  }, [agentConfigs]);

  const localProjectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of visibleLocalProjects.projects.values()) {
      const project = entry.project as { id?: string; name?: string };
      if (project.id && project.name) map.set(project.id, project.name);
    }
    return map;
  }, [visibleLocalProjects]);

  const cards = useMemo<TaskCardData[]>(() => {
    const queuePositions = computeTaskQueuePositions(tasks);
    const withRollup = tasks.map((task) => {
      const rollup = rollups.get(task.taskId as TaskId);
      const queuePosition = queuePositions.get(task.taskId);
      const owner = task.ownerId ? membersByUserId.get(task.ownerId) : undefined;
      return {
        ...task,
        needsYou: rollup?.needsYou ?? false,
        unreadMention: hasUnreadTaskMention(task, userId, threadReadAt[task.taskId]),
        ...(owner?.name ? { ownerName: owner.name } : {}),
        ...(owner?.image ? { ownerImage: owner.image } : {}),
        ...(queuePosition !== undefined ? { queuePosition } : {}),
        ...(task.agentConfigId && agentNameById.has(task.agentConfigId)
          ? { agentName: agentNameById.get(task.agentConfigId) as string }
          : {}),
        ...(() => {
          if (!task.projectKey) return {};
          if (task.projectKind === 'github') {
            // Already a name; the owner prefix is noise on a narrow card.
            return { projectName: task.projectKey.split('/').pop() ?? task.projectKey };
          }
          const name = localProjectNameById.get(task.projectKey);
          return name ? { projectName: name } : {};
        })(),
      };
    });
    // Keep manual `order` as the only sort: needs-you is a badge, not a
    // second ordering axis — board drag would fight a needsYou pin.
    return needsYouOnly ? withRollup.filter((task) => task.needsYou) : withRollup;
  }, [
    agentNameById,
    localProjectNameById,
    membersByUserId,
    needsYouOnly,
    rollups,
    tasks,
    threadReadAt,
    userId,
  ]);

  const handleOpenTask = useCallback(
    (taskId: string) => {
      if (!workspaceSlug) {
        return;
      }
      void router.navigate({
        to: '/$workspaceName/tasks/$taskId',
        params: { workspaceName: workspaceSlug, taskId },
      });
    },
    [router, workspaceSlug]
  );

  const handleBoardMove = useCallback(
    (move: TaskBoardMove) => {
      const byId = new Map(tasks.map((task) => [task.taskId, task]));
      const row = byId.get(move.taskId);
      if (!row) return;

      const beforeOrder = move.beforeTaskId ? (byId.get(move.beforeTaskId)?.order ?? null) : null;
      const afterOrder = move.afterTaskId ? (byId.get(move.afterTaskId)?.order ?? null) : null;

      let order: string;
      try {
        order = generateTaskOrderKeyBetween(beforeOrder, afterOrder, Math.random);
      } catch {
        // Neighbours out of sequence (stale index) — skip rather than throw.
        return;
      }

      const statusChanged = row.status !== move.toStatus;
      // Optimistic index patch so the card does not snap back while the doc
      // write + republish catch up. The next syncIndexRow overwrites with truth.
      setTaskIndexRows((previous) => {
        const current = previous[move.taskId];
        if (!current) return previous;
        return {
          ...previous,
          [move.taskId]: {
            ...current,
            order,
            ...(statusChanged ? { status: move.toStatus } : {}),
          },
        };
      });

      void updateTaskFields(move.taskId as TaskId, {
        order,
        ...(statusChanged ? { status: move.toStatus } : {}),
      });
    },
    [setTaskIndexRows, tasks, updateTaskFields]
  );

  // Board claims the leftover viewport height so columns stretch and the
  // horizontal scrollbar sits on the board floor. List must NOT do that —
  // it grows with content and scrolls inside ScrollArea; `h-full` +
  // `overflow-hidden` would clip rows instead of letting the page scroll.
  const boardFillsViewport = !isMobile && layout === 'board';

  const body = (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col',
        // Match the desktop sidebar card's bottom inset (`mb-2` on
        // LoroAppSidebar): the board must not run flush to the window edge
        // while the sidebar floats 8px above it.
        boardFillsViewport && 'h-full pb-2'
      )}
    >
      {inboxItems.length > 0 ? (
        <div className="shrink-0 px-3 pt-3">
          <TaskInboxPanel items={inboxItems} onOpenTask={handleOpenTask} now={now} />
        </div>
      ) : null}
      <div className={cn('flex min-h-0 flex-1 flex-col', boardFillsViewport && 'overflow-hidden')}>
        <TasksBoardView
          tasks={cards}
          onOpenTask={handleOpenTask}
          onQuickAdd={handleQuickAdd}
          onMove={effectiveLayout === 'board' ? handleBoardMove : undefined}
          layout={effectiveLayout}
          visibleProperties={visibleByView[effectiveLayout] ?? []}
        />
      </div>
    </div>
  );

  if (!isMobile) {
    // Desktop: chrome is the workspace tab bar. Body fills the rest.
    return layout === 'list' ? (
      <ScrollArea className="min-h-0 flex-1">{body}</ScrollArea>
    ) : (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
    );
  }

  const mobileActions = (
    <div className="flex items-center gap-1">
      <Button
        variant={needsYouOnly ? 'primary' : 'secondary'}
        size="small"
        onClick={() => setNeedsYouOnly(!needsYouOnly)}
      >
        {t('tasks.needsYou', 'Needs you')}
      </Button>
      <Button size="small" onClick={() => handleQuickAdd()}>
        <Plus className="h-4 w-4" />
        {t('tasks.newTask', 'New task')}
      </Button>
    </div>
  );

  /* Embedded under the mobile home header: a compact toolbar without
     safe-area inset or the drawer Menu button. BaseHeader always adds
     `pt-[var(--safe-area-top)]` on native, which under the home chrome
     reads as a large empty band at the top of the Tasks tab. */
  const mobileChrome = embedded ? (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <ListTodo className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
        {t('tasks.title', 'Tasks')}
      </h2>
      {mobileActions}
    </div>
  ) : (
    <BaseHeader
      title={t('tasks.title', 'Tasks')}
      leading={<ListTodo className="h-4 w-4 text-muted-foreground" />}
      actions={mobileActions}
    />
  );

  return (
    <TooltipProvider>
      <div
        className={cn(
          TASKS_SURFACE_CLASS,
          'flex h-full w-full flex-1 flex-col overflow-hidden bg-background'
        )}
      >
        {mobileChrome}
        <ScrollArea className="flex-1">{body}</ScrollArea>
      </div>
    </TooltipProvider>
  );
}

// Re-export for callers that still import the list page by the old name.
export { TasksWorkspace as TasksView };
