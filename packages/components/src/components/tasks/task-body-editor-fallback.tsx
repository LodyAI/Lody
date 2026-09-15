import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Pencil, Quote } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import type { TaskBodyEditorProps } from './task-body-editor';

const IDLE_COMMIT_MS = 1200;

type PendingBodyCommit = {
  body: string;
  base: string;
  failed: boolean;
};

/**
 * Markdown source editor with a rendered preview — the body editor for browsers
 * that cannot run meowdown.
 *
 * meowdown's substitution table builds a lookbehind regex at module scope.
 * esbuild lowers that literal to `new RegExp(...)` for our old-Safari target,
 * so on iOS Safari < 16.4 merely importing the editor throws and takes the
 * whole chunk with it. Rather than ship a page that breaks there, the wrapper
 * feature-detects lookbehind and renders this instead: the same stored
 * Markdown, edited as source. Everything below is the editor Tasks shipped with
 * before the meowdown swap.
 */
export default function TaskBodyEditorFallback({
  value,
  disabled = false,
  onCommit,
  onQuoteSelection,
  onImagePaste,
}: TaskBodyEditorProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'edit' | 'preview'>(value.trim() ? 'preview' : 'edit');
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(value);
  const latestValueRef = useRef(value);
  const latestOnCommitRef = useRef(onCommit);
  const latestTRef = useRef(t);
  const lastSyncedRef = useRef(value);
  const pendingCommitRef = useRef<PendingBodyCommit | null>(null);
  latestValueRef.current = value;
  latestOnCommitRef.current = onCommit;
  latestTRef.current = t;

  // Adopt remote changes only while the user is not typing.
  useEffect(() => {
    if (editing) return;

    const pending = pendingCommitRef.current;
    if (pending) {
      if (value === pending.body) {
        pendingCommitRef.current = null;
        lastSyncedRef.current = value;
        return;
      }
      if (value === pending.base) {
        return;
      }
      if (pending.failed) {
        return;
      }
      pendingCommitRef.current = null;
    }

    if (value === lastSyncedRef.current) return;
    lastSyncedRef.current = value;
    draftRef.current = value;
    setDraft(value);
  }, [editing, value]);

  const commitNow = useCallback((next: string, retryPending = false) => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    const pending = pendingCommitRef.current;
    if (!pending && next === lastSyncedRef.current) return;
    if (pending?.body === next && !pending.failed && !retryPending) return;

    const attempt: PendingBodyCommit = {
      body: next,
      base: latestValueRef.current,
      failed: false,
    };
    pendingCommitRef.current = attempt;

    let result: void | Promise<void>;
    try {
      result = latestOnCommitRef.current(next);
    } catch (error) {
      attempt.failed = true;
      toast.error(
        error instanceof Error
          ? error.message
          : latestTRef.current(
              'tasks.body.saveFailed',
              'Could not save the description. Please try again.'
            )
      );
      return;
    }

    void Promise.resolve(result).then(
      () => {
        if (pendingCommitRef.current !== attempt) return;
        // Keep guarding the previous prop until the document layer echoes the
        // exact body that was written.
        lastSyncedRef.current = next;
      },
      (error: unknown) => {
        if (pendingCommitRef.current !== attempt) return;
        attempt.failed = true;
        toast.error(
          error instanceof Error
            ? error.message
            : latestTRef.current(
                'tasks.body.saveFailed',
                'Could not save the description. Please try again.'
              )
        );
      }
    );
  }, []);

  useEffect(
    () => () => {
      // The component is about to lose its local draft guard, so re-issue an
      // in-flight body write as a final idempotent persistence attempt.
      commitNow(draftRef.current, true);
    },
    [commitNow]
  );

  const scheduleCommit = (next: string) => {
    draftRef.current = next;
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = setTimeout(() => {
      commitNow(next);
    }, IDLE_COMMIT_MS);
  };

  const handleQuote = () => {
    const element = textareaRef.current;
    if (!element || !onQuoteSelection) {
      return;
    }
    const selection = element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0);
    if (selection.trim()) {
      onQuoteSelection(selection.trim());
    }
  };

  const insertImageFiles = async (files: readonly File[]) => {
    if (!onImagePaste || files.length === 0) return;
    const references: string[] = [];
    for (const file of files) {
      try {
        const destination = await onImagePaste(file);
        const alt = file.name.replaceAll(/[\\\]]/gu, '\\$&');
        if (destination) references.push(`![${alt}](${destination})`);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t('tasks.images.uploadFailed', 'Upload failed')
        );
      }
    }
    if (references.length === 0) return;
    const next = `${draft}${draft && !draft.endsWith('\n') ? '\n' : ''}${references.join('\n')}`;
    draftRef.current = next;
    setDraft(next);
    scheduleCommit(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-1">
        {mode === 'edit' && onQuoteSelection ? (
          <Button size="sm" variant="ghost" onClick={handleQuote}>
            <Quote className="h-3.5 w-3.5" />
            {t('tasks.body.quote', 'Quote selection')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setMode(mode === 'edit' ? 'preview' : 'edit')}
        >
          {mode === 'edit' ? (
            <>
              <Eye className="h-3.5 w-3.5" />
              {t('tasks.body.preview', 'Preview')}
            </>
          ) : (
            <>
              <Pencil className="h-3.5 w-3.5" />
              {t('tasks.body.edit', 'Edit')}
            </>
          )}
        </Button>
      </div>

      {mode === 'edit' ? (
        <Textarea
          ref={textareaRef}
          value={draft}
          disabled={disabled}
          rows={14}
          placeholder={t('tasks.body.placeholderShort', 'Add description…')}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text/plain');
            if (text.length > 0) return;
            const files = Array.from(event.clipboardData.files).filter((file) =>
              file.type.startsWith('image/')
            );
            if (files.length === 0) return;
            event.preventDefault();
            void insertImageFiles(files);
          }}
          onFocus={() => setEditing(true)}
          onChange={(event) => {
            draftRef.current = event.target.value;
            setDraft(event.target.value);
            scheduleCommit(event.target.value);
          }}
          onBlur={() => {
            setEditing(false);
            commitNow(draft);
          }}
        />
      ) : (
        // Deliberately NOT a <button>: a rendered body contains links, task
        // checkboxes, and code blocks, and nesting those inside a button both
        // breaks the HTML content model and swallows link clicks. Keyboard and
        // assistive-tech users reach edit mode through the header toggle, which
        // is a real button; this click target is a mouse affordance on top.
        <div
          className="min-h-24 w-full rounded-md border border-transparent p-1 text-left hover:border-border"
          onClick={(event) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest('a, button, input, label, select, textarea')) {
              return;
            }
            setMode('edit');
          }}
        >
          {draft.trim() ? (
            <MarkdownRenderer text={draft} size="sm" />
          ) : (
            <span className="text-sm text-muted-foreground/60">
              {t('tasks.body.placeholderShort', 'Add description…')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
