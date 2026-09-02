import { useCallback, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ListTodo } from 'lucide-react';
import type { SessionId, TaskProposalMeta } from '@lody/shared';
import { currentWorkspaceSlugAtom } from '@/atoms';
import { useTaskActions } from '@/hooks/use-task-actions';
import { Button } from '@lody/ui/button';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';

export type TaskProposalNoticeProps = {
  meta: TaskProposalMeta;
  sessionId: SessionId;
  /** History entry carrying this notice, so the outcome can be written back. */
  entryId: string;
  itemIndex: number;
};

/**
 * An agent's suggestion to record work as a task, rendered inline in the
 * conversation.
 *
 * The card is part of session history rather than a dialog, so a proposal made
 * while nobody was watching is still there — and still actionable — days later.
 * Confirming is what creates the task; ignoring creates nothing.
 */
export function TaskProposalNotice({
  meta,
  sessionId,
  entryId,
  itemIndex,
}: TaskProposalNoticeProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const { createTask, linkSession, resolveTaskProposal } = useTaskActions();
  const [busy, setBusy] = useState(false);

  const resolve = useCallback(
    async (outcome: 'created' | 'dismissed', taskId?: string) => {
      await resolveTaskProposal(sessionId, entryId, itemIndex, {
        ...meta,
        outcome,
        ...(taskId ? { taskId } : {}),
      });
    },
    [entryId, itemIndex, meta, resolveTaskProposal, sessionId]
  );

  const openTask = useCallback(
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

  const handleCreate = useCallback(() => {
    void (async () => {
      setBusy(true);
      try {
        const taskId = await createTask({ title: meta.title, body: meta.body });
        if (!taskId) {
          return;
        }
        // The proposing conversation becomes the task's first linked session, so
        // the task can answer where it came from.
        await linkSession(taskId, sessionId, 'propose-source');
        await resolve('created', taskId);
      } catch (error: unknown) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    })();
  }, [createTask, linkSession, meta.body, meta.title, resolve, sessionId]);

  const handleDismiss = useCallback(() => {
    void (async () => {
      setBusy(true);
      try {
        await resolve('dismissed');
      } finally {
        setBusy(false);
      }
    })();
  }, [resolve]);

  if (meta.outcome === 'created') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        <ListTodo className="h-3.5 w-3.5" />
        <span>{t('tasks.proposal.created', 'Task created')}</span>
        <span className="min-w-0 flex-1 truncate text-foreground">{meta.title}</span>
        {meta.taskId ? (
          <Button variant="ghost" size="small" onClick={() => openTask(meta.taskId as string)}>
            {t('tasks.proposal.openTask', 'Open task')}
          </Button>
        ) : null}
      </div>
    );
  }

  if (meta.outcome === 'dismissed') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
        <ListTodo className="h-3.5 w-3.5" />
        <span>{t('tasks.proposal.dismissed', 'Proposal ignored')}</span>
        <span className="min-w-0 flex-1 truncate line-through">{meta.title}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ListTodo className="h-3.5 w-3.5" />
        <span>{t('tasks.proposal.title', 'Record this as a task?')}</span>
        {meta.proposedBy?.name ? (
          <span className="ml-auto truncate">
            {t('tasks.proposal.by', 'Proposed by {{name}}', { name: meta.proposedBy.name })}
          </span>
        ) : null}
      </div>
      <p className="text-sm font-medium">{meta.title}</p>
      {meta.body ? (
        <div className="max-h-48 overflow-y-auto rounded border border-border/60 p-2">
          <MarkdownRenderer text={meta.body} size="sm" />
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="small" disabled={busy} onClick={handleDismiss}>
          {t('tasks.proposal.dismiss', 'Ignore')}
        </Button>
        <Button size="small" disabled={busy} onClick={handleCreate}>
          {t('tasks.proposal.create', 'Create task')}
        </Button>
      </div>
    </div>
  );
}
