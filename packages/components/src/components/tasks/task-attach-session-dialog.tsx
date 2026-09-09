import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessagesSquare, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { ScrollArea } from '@/ui/scroll-area';
import { TASKS_SURFACE_CLASS } from './tasks-surface';

export type AttachableSession = {
  sessionId: string;
  title: string;
  /** Repo or project label, to tell similarly named sessions apart. */
  contextLabel?: string;
  lastMessageAt?: number;
  /** Already recorded under another task; shown, but not selectable. */
  attachedTaskTitle?: string;
};

export type TaskAttachSessionDialogProps = {
  open: boolean;
  sessions: readonly AttachableSession[];
  onAttach: (sessionId: string) => void;
  onClose: () => void;
};

/**
 * Records an existing conversation under a task.
 *
 * Sessions that already belong to another task are listed but disabled with the
 * reason, rather than filtered out: an option that silently disappears cannot
 * explain itself, and "why isn't my chat here?" is the obvious question.
 */
export function TaskAttachSessionDialog({
  open,
  sessions,
  onAttach,
  onClose,
}: TaskAttachSessionDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return sessions;
    }
    return sessions.filter((session) =>
      `${session.title} ${session.contextLabel ?? ''}`.toLowerCase().includes(needle)
    );
  }, [query, sessions]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery('');
          onClose();
        }
      }}
    >
      <DialogContent className={cn(TASKS_SURFACE_CLASS, 'max-w-lg')}>
        <DialogHeader>
          <DialogTitle>{t('tasks.attach.title', 'Attach a session')}</DialogTitle>
          <DialogDescription>
            {t(
              'tasks.attach.description',
              'Record an existing conversation under this task, so the work shows up here.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            className="pl-8"
            placeholder={t('tasks.attach.searchPlaceholder', 'Search conversations…')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <ScrollArea className="max-h-72">
          {filtered.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              {t('tasks.attach.empty', 'No conversations to attach')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {filtered.map((session) => {
                const taken = session.attachedTaskTitle !== undefined;
                return (
                  <li key={session.sessionId}>
                    <button
                      type="button"
                      disabled={taken}
                      onClick={() => onAttach(session.sessionId)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm',
                        taken
                          ? 'cursor-not-allowed text-muted-foreground'
                          : 'hover:bg-muted-foreground/10'
                      )}
                    >
                      <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {session.title || t('tasks.sessionUntitled', 'Session')}
                      </span>
                      {taken ? (
                        <span className="shrink-0 text-xs text-muted-foreground/70">
                          {t('tasks.attach.alreadyAttached', 'already on “{{task}}”', {
                            task: session.attachedTaskTitle,
                          })}
                        </span>
                      ) : session.contextLabel ? (
                        <span className="shrink-0 truncate text-xs text-muted-foreground">
                          {session.contextLabel}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>

        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
