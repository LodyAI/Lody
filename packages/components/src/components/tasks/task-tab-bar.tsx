import { ListTodo, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  WINDOW_DRAG_EXEMPT_CLASS,
  useWindowDragRegionClass,
  useWindowsCaptionPadClass,
} from '@/ui/window-drag-region';
import {
  TAB_PILL_ACTIVE_CLASS,
  TAB_PILL_INACTIVE_CLASS,
} from '@/components/shared/tab-pill-strip';

export type TaskTabItem = {
  taskId: string;
  title: string;
};

export type TaskTabBarProps = {
  /** Open task detail tabs, in display order. */
  tabs: readonly TaskTabItem[];
  /** `null` means the pinned "All Tasks" home tab is active. */
  activeTaskId: string | null;
  onSelectAll: () => void;
  onSelectTask: (taskId: string) => void;
  onCloseTask: (taskId: string) => void;
  /** Far-right chrome (Filter + New task on All Tasks, …). */
  rightSlot?: React.ReactNode;
};

/**
 * Same surface ladder and pill chrome as the main conversation tab bar
 * (`session-tab-bar.tsx` / `TAB_PILL_*`), but for the Tasks workspace: a pinned
 * "All Tasks" home tab plus closable detail tabs for every task the user has
 * opened. No drag-reorder or adaptive width sharing — the open set stays small
 * enough that equal shrink is fine, and reordering has no durable meaning yet.
 */
const TAB_ITEM_CLASS =
  'group relative flex h-8 min-w-0 max-w-[12rem] items-center gap-1.5 overflow-hidden rounded-md border border-transparent px-3 text-[13px] transition-colors cursor-pointer';

const TAB_INLINE_ACTION_CLASS =
  'ml-auto shrink-0 rounded-sm p-0.5 opacity-70 transition-[opacity,background-color,color] hover:bg-muted-foreground/10 hover:text-tab-hover-foreground hover:opacity-100';

export function TaskTabBar({
  tabs,
  activeTaskId,
  onSelectAll,
  onSelectTask,
  onCloseTask,
  rightSlot,
}: TaskTabBarProps) {
  const { t } = useTranslation();
  const windowDragClass = useWindowDragRegionClass();
  const windowsCaptionPadClass = useWindowsCaptionPadClass();
  const allActive = activeTaskId === null;
  // When only All Tasks is open, the pill reads as page chrome rather than a
  // selected sibling among many — same "solo" treatment as SessionTabBar.
  const solo = tabs.length === 0;

  return (
    <div
      className={cn(
        'flex h-11 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2',
        windowDragClass,
        windowsCaptionPadClass
      )}
    >
      <div
        role="tablist"
        aria-label={t('tasks.tabs.label', 'Task tabs')}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        <div
          role="tab"
          aria-selected={allActive}
          tabIndex={allActive ? 0 : -1}
          onClick={onSelectAll}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelectAll();
            }
          }}
          className={cn(
            TAB_ITEM_CLASS,
            'shrink-0 cursor-pointer font-medium',
            !solo && WINDOW_DRAG_EXEMPT_CLASS,
            solo
              ? 'text-tab-active-foreground'
              : allActive
                ? TAB_PILL_ACTIVE_CLASS
                : TAB_PILL_INACTIVE_CLASS
          )}
        >
          <ListTodo className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="truncate">{t('tasks.tabs.allTasks', 'All Tasks')}</span>
        </div>

        {tabs.map((tab) => {
          const active = tab.taskId === activeTaskId;
          const label = tab.title.trim() || t('tasks.untitled', 'Untitled task');
          return (
            <div
              key={tab.taskId}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              aria-label={label}
              className={cn(
                TAB_ITEM_CLASS,
                WINDOW_DRAG_EXEMPT_CLASS,
                active ? TAB_PILL_ACTIVE_CLASS : TAB_PILL_INACTIVE_CLASS
              )}
              onClick={() => onSelectTask(tab.taskId)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectTask(tab.taskId);
                }
              }}
            >
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <button
                type="button"
                className={cn(
                  TAB_INLINE_ACTION_CLASS,
                  active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTask(tab.taskId);
                }}
                aria-label={t('tasks.tabs.closeTab', 'Close tab')}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      {rightSlot ? (
        <div className={cn('ml-1 flex shrink-0 items-center gap-1', WINDOW_DRAG_EXEMPT_CLASS)}>
          {rightSlot}
        </div>
      ) : null}
    </div>
  );
}
