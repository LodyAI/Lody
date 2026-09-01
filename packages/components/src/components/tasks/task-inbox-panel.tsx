import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { AtSign } from 'lucide-react';
import { formatCompactRelativeTime } from '@/lib/format-relative-time';
import { FocusScope, useListKeyboardNavigation } from '@/ui/focus-scope';

export type TaskInboxItem = {
  taskId: string;
  title: string;
  /** When the mentioning comment landed; drives the ordering and the timestamp. */
  lastCommentAt?: number;
};

export type TaskInboxPanelProps = {
  items: TaskInboxItem[];
  onOpenTask: (taskId: string) => void;
  /** Injected so labels are stable across renders (and fixed in stories/tests). */
  now?: Date;
};

/**
 * Unread `@`-mentions, newest first.
 *
 * Renders nothing when there is nothing to read. That is the design, not an
 * optimization: an inbox that is permanently present but usually empty trains
 * people to ignore it, and this one has no state of its own to show off —
 * opening a task marks it read and the row disappears. An empty inbox should
 * cost zero pixels.
 *
 * Scope is only mentions. "Assigned to me" and "blocked on me" already have
 * homes (the board, and the needs-you filter), and pulling them in here would
 * turn a list you can finish into a second copy of the task list.
 */
export function TaskInboxPanel({ items, onOpenTask, now }: TaskInboxPanelProps) {
  const { t } = useTranslation();
  const scopeId = useId();
  useListKeyboardNavigation({ scopeId });

  if (items.length === 0) return null;

  return (
    <FocusScope
      id={scopeId}
      role="region"
      className="rounded-lg border border-border bg-sidebar p-2"
      aria-label={t('tasks.inbox.title', 'Inbox')}
    >
      <div className="flex items-center gap-1.5 px-1 pb-1.5">
        <AtSign className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="text-xs font-semibold text-muted-foreground">
          {t('tasks.inbox.title', 'Inbox')}
        </h2>
        <span className="text-xs text-muted-foreground/70">
          {t('tasks.inbox.count', '{{count}} unread', { count: items.length })}
        </span>
      </div>

      <ul className="flex flex-col">
        {items.map((item) => (
          <li key={item.taskId}>
            <button
              type="button"
              data-id={`task-inbox:${item.taskId}`}
              data-scope-item="row"
              onClick={() => onOpenTask(item.taskId)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted-foreground/10"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                {item.title.trim() || t('tasks.untitled', 'Untitled task')}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {item.lastCommentAt ? formatCompactRelativeTime(item.lastCommentAt, now) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </FocusScope>
  );
}
