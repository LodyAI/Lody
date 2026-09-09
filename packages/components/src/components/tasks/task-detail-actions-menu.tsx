import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Link2, MoreHorizontal } from 'lucide-react';
import type { TaskId } from '@lody/shared';
import { useTaskDoc } from '@/hooks/use-task-doc';
import { Button } from '@lody/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { tasksMenuClassName, tasksMenuSurfaceStyle } from './tasks-surface';

/**
 * Per-task overflow actions, in the tab bar's right slot beside the open task.
 *
 * Things that act on the task as a whole live here rather than on the surfaces
 * they read from: "Copy as Markdown" used to be a hover button inside the
 * description, which put a document-level action inside one of the document's
 * own fields and made it discoverable only by hovering the right spot.
 */
export function TaskDetailActionsMenu({
  taskId,
  workspaceSlug,
}: {
  taskId: TaskId;
  workspaceSlug: string | null;
}) {
  const { t } = useTranslation();
  const { state } = useTaskDoc(taskId);
  const [copied, setCopied] = useState<'markdown' | 'url' | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const flash = useCallback((which: 'markdown' | 'url') => {
    setCopied(which);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(null), 1500);
  }, []);

  const copyMarkdown = useCallback(() => {
    // The committed body, not the editor's in-flight buffer: opening this menu
    // blurs the editor, which flushes its pending commit first.
    const title = (state.meta as unknown as { title?: string })?.title ?? '';
    const body = (state.body ?? '') as unknown as string;
    const markdown = title ? `# ${title}\n\n${body}` : body;
    void navigator.clipboard.writeText(markdown).then(() => flash('markdown'));
  }, [flash, state]);

  const copyUrl = useCallback(() => {
    if (!workspaceSlug) return;
    const url = `${window.location.origin}/${workspaceSlug}/tasks/${taskId}`;
    void navigator.clipboard.writeText(url).then(() => flash('url'));
  }, [flash, taskId, workspaceSlug]);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" aria-label={t('tasks.actions.more', 'More actions')} icon>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('tasks.actions.more', 'More actions')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className={tasksMenuClassName('w-56')}
        style={tasksMenuSurfaceStyle}
      >
        <DropdownMenuItem onClick={copyMarkdown}>
          <Copy className="h-3.5 w-3.5" />
          <span className="flex-1">{t('tasks.body.copyMarkdown', 'Copy as Markdown')}</span>
          {copied === 'markdown' ? <Check className="h-3.5 w-3.5 text-foreground" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={copyUrl} disabled={!workspaceSlug}>
          <Link2 className="h-3.5 w-3.5" />
          <span className="flex-1">{t('tasks.actions.copyUrl', 'Copy task URL')}</span>
          {copied === 'url' ? <Check className="h-3.5 w-3.5 text-foreground" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
