import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUp,
  Bot,
  Image as ImageIcon,
  Loader2,
  MessagesSquare,
  Unlink,
  User,
  X,
} from 'lucide-react';
import {
  buildTaskImageMarkdownUrl,
  extractTaskImageIdsFromMarkdown,
  type TaskActivityType,
  type TaskTimelineEntry,
} from '@lody/shared';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import {
  TASK_SESSION_ACTIVITY_PRESENTATION,
  type TaskSessionActivity,
} from './task-session-activity';

/** A linked conversation, rendered inline in the timeline. */
export type TaskThreadSessionEvent = {
  linkId: string;
  sessionId: string;
  title: string;
  /** Where the link came from, already localized by the caller. */
  provenance: string;
  linkedAt: number;
  actorName?: string | undefined;
  actorKind?: 'human' | 'agent' | undefined;
  /**
   * What the conversation is doing right now. `null`/absent = this client has
   * no meta for it, which is drawn as nothing rather than as idle.
   */
  activity?: TaskSessionActivity | null | undefined;
};

export type TaskThreadProps = {
  entries: readonly TaskTimelineEntry[];
  /**
   * Linked conversations, merged into the same timeline by time. They are NOT
   * a separate section: a task's history is one story, and splitting "sessions"
   * out meant the reader had to interleave two lists by hand.
   */
  sessionEvents?: readonly TaskThreadSessionEvent[];
  disabled?: boolean;
  /** Pre-filled quote for the next comment, set by quoting the body. */
  pendingQuote?: string | null;
  onClearQuote?: () => void;
  onSubmit: (input: { body: string; quote?: string }) => void;
  onImagePaste?: (file: File) => Promise<string | undefined>;
  imageAccept?: string;
  /** Navigate to the session an entry came from or was dispatched into. */
  onOpenSession?: (sessionId: string) => void;
  /** Unlink a conversation from this task. */
  onDetachSession?: (sessionId: string) => void;
  /** Rendered next to the section title (e.g. Attach a conversation). */
  headerAction?: React.ReactNode;
};

/**
 * Only associations are shown. Property edits — status, owner, agent, body —
 * are deliberately NOT in the timeline.
 *
 * They were, and they were unreadable: `activityData` is a record of raw field
 * values, so "changed the agent" rendered followed by an agent config UUID.
 * Making those legible would mean resolving ids to names for every field the
 * task carries, which buys a log nobody reads — the current value of each field
 * is already visible in the properties rail one column over. What the rail
 * CANNOT show is which conversations this task spawned and when, so that is
 * what the timeline keeps.
 */
const isVisibleActivity = (type: TaskActivityType | undefined): boolean => type === 'pr_linked';

const activityLabelKey = (
  type: TaskActivityType | undefined
): { key: string; fallback: string } => {
  switch (type) {
    case 'pr_linked':
      return { key: 'tasks.activity.prLinked', fallback: 'linked a pull request' };
    default:
      return { key: 'tasks.activity.unknown', fallback: 'updated this task' };
  }
};

/**
 * Comments and activity in one timeline.
 *
 * This is a coordination surface, not a control surface: posting writes a record
 * and never spends a turn. Mentioning an agent is the one explicit way to turn a
 * comment into work, and that dispatch happens in a session, which is where
 * execution lives.
 *
 * Visual language follows Linear's Activity: sentence-case section title, soft
 * timeline rows (no card chrome on every activity), and a single quiet comment
 * composer rather than a labeled form with a primary "Comment" button.
 */
export function TaskThread({
  entries,
  sessionEvents,
  headerAction,
  disabled = false,
  pendingQuote,
  onClearQuote,
  onSubmit,
  onImagePaste,
  imageAccept,
  onOpenSession,
  onDetachSession,
}: TaskThreadProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [uploadingImages, setUploadingImages] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const previewMarkdown = useMemo(
    () =>
      extractTaskImageIdsFromMarkdown(draft)
        .map((imageId) => `![](${buildTaskImageMarkdownUrl(imageId)})`)
        .join('\n'),
    [draft]
  );

  const handleSubmit = () => {
    if (!draft.trim() || uploadingImages) {
      return;
    }
    onSubmit({ body: draft, ...(pendingQuote ? { quote: pendingQuote } : {}) });
    setDraft('');
    onClearQuote?.();
  };

  const handleImageFiles = async (files: readonly File[]) => {
    if (!onImagePaste || files.length === 0) return;
    setUploadingImages(true);
    try {
      const references: string[] = [];
      for (const file of files) {
        const destination = await onImagePaste(file);
        if (!destination) continue;
        const alt = file.name.replaceAll(/[\\\]]/gu, '\\$&');
        references.push(`![${alt}](${destination})`);
      }
      if (references.length > 0) {
        setDraft((current) => {
          const separator = current && !current.endsWith('\n') ? '\n' : '';
          return `${current}${separator}${references.join('\n')}`;
        });
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('tasks.images.uploadFailed', 'Upload failed')
      );
    } finally {
      setUploadingImages(false);
    }
  };

  const handleImageInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    void handleImageFiles(files);
  };

  // One chronological stream: comments, the few visible activities, and linked
  // conversations. Sorting a tagged union here (rather than rendering three
  // lists) is the whole point — the reader should not have to interleave.
  type Row =
    | { kind: 'entry'; at: number; id: string; entry: TaskTimelineEntry }
    | { kind: 'session'; at: number; id: string; session: TaskThreadSessionEvent };

  const ordered: Row[] = [
    ...entries
      .filter((entry) => entry.kind !== 'activity' || isVisibleActivity(entry.activityType))
      .map((entry): Row => ({ kind: 'entry', at: entry.createdAt, id: entry.id, entry })),
    ...(sessionEvents ?? []).map(
      (session): Row => ({
        kind: 'session',
        at: session.linkedAt,
        id: `session:${session.linkId}`,
        session,
      })
    ),
  ].sort((a, b) => a.at - b.at);

  return (
    <div className="flex flex-col gap-4">
      {/* No "Activity" heading: the timeline is self-evident from its content,
         and a label on it only competes with the task title above. The row
         stays so the Attach action keeps its place; it collapses when there is
         no action to put in it. */}
      {headerAction ? (
        <div className="flex items-center justify-end gap-2">{headerAction}</div>
      ) : null}

      <ol className="flex flex-col gap-0">
        {ordered.map((row, index) => {
          const isLastRow = index === ordered.length - 1;

          if (row.kind === 'session') {
            const { session } = row;
            const sessionActor = session.actorName;
            return (
              <li key={row.id} className="relative flex gap-3 pb-4">
                {!isLastRow ? (
                  <span
                    aria-hidden
                    className="absolute left-[9px] top-5 bottom-0 w-px bg-border/70"
                  />
                ) : null}
                <span className="relative z-[1] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-muted-foreground/10">
                  <MessagesSquare className="h-2.5 w-2.5 text-muted-foreground" />
                </span>
                <div className="group min-w-0 flex-1 pt-px">
                  <div className="flex min-w-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => onOpenSession?.(session.sessionId)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 -ml-1.5 text-left text-[13px] transition-colors hover:bg-muted-foreground/[0.06]"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground/85">
                        {session.title}
                      </span>
                      {/* Whether the conversation is still working is the first
                         thing you want from a linked session, and the row used
                         to say nothing about it. Absent when this client has no
                         meta — unknown must not read as finished. */}
                      {session.activity ? (
                        <span
                          className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                            TASK_SESSION_ACTIVITY_PRESENTATION[session.activity].className
                          )}
                        >
                          {t(
                            TASK_SESSION_ACTIVITY_PRESENTATION[session.activity].labelKey,
                            TASK_SESSION_ACTIVITY_PRESENTATION[session.activity].labelFallback
                          )}
                        </span>
                      ) : null}
                    </button>
                    {onDetachSession ? (
                      <button
                        type="button"
                        aria-label={t('tasks.detach.action', 'Detach')}
                        onClick={() => onDetachSession(session.sessionId)}
                        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Unlink className="h-3 w-3" />
                      </button>
                    ) : null}
                  </div>
                  <p className="px-1.5 -ml-1.5 text-[11px] leading-snug text-muted-foreground">
                    {sessionActor ? `${sessionActor} · ` : ''}
                    {session.provenance}
                  </p>
                </div>
              </li>
            );
          }

          const entry = row.entry;
          const isAgent = entry.actorKind === 'agent';
          const who =
            entry.actorName ??
            (isAgent ? t('tasks.thread.agent', 'Agent') : t('tasks.thread.someone', 'Someone'));
          const isLast = index === ordered.length - 1;

          if (entry.kind === 'activity') {
            // No `?? 'created'`: an entry whose type is missing must not claim the
            // task was created — that is a specific, false statement in an audit
            // trail, and it happens exactly once per task. Fall to the neutral
            // default instead.
            const label = activityLabelKey(entry.activityType);
            return (
              <li key={entry.id} className="relative flex gap-3 pb-4">
                {!isLast ? (
                  <span
                    aria-hidden
                    className="absolute left-[9px] top-5 bottom-0 w-px bg-border/70"
                  />
                ) : null}
                <span className="relative z-[1] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-muted-foreground/10">
                  {isAgent ? (
                    <Bot className="h-2.5 w-2.5 text-muted-foreground" />
                  ) : (
                    <User className="h-2.5 w-2.5 text-muted-foreground" />
                  )}
                </span>
                <p className="min-w-0 flex-1 pt-px text-[13px] leading-snug text-muted-foreground">
                  <span className="font-medium text-foreground/80">{who}</span>{' '}
                  {t(label.key, label.fallback)}
                </p>
              </li>
            );
          }

          return (
            <li key={entry.id} className="relative flex gap-3 pb-4">
              {!isLast ? (
                <span
                  aria-hidden
                  className="absolute left-[9px] top-5 bottom-0 w-px bg-border/70"
                />
              ) : null}
              <span className="relative z-[1] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-muted-foreground/15">
                {isAgent ? (
                  <Bot className="h-2.5 w-2.5 text-muted-foreground" />
                ) : (
                  <User className="h-2.5 w-2.5 text-muted-foreground" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
                  <span className="font-medium text-foreground/85">{who}</span>
                  {entry.originSessionId && onOpenSession ? (
                    <button
                      type="button"
                      className="text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => onOpenSession(entry.originSessionId as string)}
                    >
                      {t('tasks.thread.fromSession', 'from a session')}
                    </button>
                  ) : null}
                  {entry.dispatchedSessionId && onOpenSession ? (
                    <button
                      type="button"
                      className="text-status-info underline-offset-2 hover:underline"
                      onClick={() => onOpenSession(entry.dispatchedSessionId as string)}
                    >
                      {t('tasks.thread.dispatched', 'sent to a session')}
                    </button>
                  ) : null}
                </div>
                {entry.quote ? (
                  <blockquote className="mb-1.5 border-l-2 border-border pl-2 text-xs text-muted-foreground">
                    {entry.quote}
                  </blockquote>
                ) : null}
                <div className="text-[13px] leading-relaxed">
                  <MarkdownRenderer text={entry.body ?? ''} size="sm" />
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-col gap-2">
        {pendingQuote ? (
          <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-muted-foreground/[0.04] px-3 py-2">
            <blockquote className="min-w-0 flex-1 border-l-2 border-border pl-2 text-xs text-muted-foreground">
              {pendingQuote}
            </blockquote>
            <button
              type="button"
              onClick={onClearQuote}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
              aria-label={t('common.remove', 'Remove')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        <div className="relative rounded-lg border border-border/70 bg-background focus-within:border-border">
          <input
            ref={imageInputRef}
            type="file"
            accept={imageAccept}
            multiple
            hidden
            onChange={handleImageInput}
          />
          <Textarea
            value={draft}
            disabled={disabled}
            rows={3}
            placeholder={t('tasks.thread.placeholderShort', 'Leave a comment…')}
            className={cn(
              'min-h-[4.5rem] resize-none border-0 bg-transparent px-3 py-2.5 text-[13px] shadow-none',
              'placeholder:text-muted-foreground/60 focus-visible:ring-0'
            )}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => {
              const text = event.clipboardData.getData('text/plain');
              if (text.length > 0) return;
              const files = Array.from(event.clipboardData.files).filter((file) =>
                file.type.startsWith('image/')
              );
              if (files.length === 0) return;
              event.preventDefault();
              void handleImageFiles(files);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                handleSubmit();
              }
            }}
          />
          {previewMarkdown ? (
            <div className="border-t border-border/50 px-3 py-2">
              <MarkdownRenderer
                text={previewMarkdown}
                size="sm"
                className="[&_img]:max-h-28 [&_img]:w-auto"
              />
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 shrink-0"
              disabled={disabled || uploadingImages || !onImagePaste}
              onClick={() => imageInputRef.current?.click()}
              aria-label={t('tasks.thread.addImage', 'Add image')}
            >
              {uploadingImages ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ImageIcon className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              size="icon"
              variant={draft.trim() ? 'default' : 'ghost'}
              className="h-7 w-7 shrink-0"
              disabled={disabled || uploadingImages || !draft.trim()}
              onClick={handleSubmit}
              aria-label={t('tasks.thread.send', 'Comment')}
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
