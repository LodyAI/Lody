import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Quote } from 'lucide-react';
import { MeowdownEditor, type EditorHandle } from '@meowdown/react';
import { toast } from 'sonner';
import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';
import { useKeyScope } from '@/lib/commands';
import { shouldAdoptRemoteBody, type TaskBodyEditorProps } from './task-body-editor';
import { TaskBodySelectionToolbar } from './task-body-selection-toolbar';
import { TaskBodyInsertMenu } from './task-body-insert-menu';
import { useTaskImageResolver } from '@/hooks/use-task-image';
// Core ships tokens (`--meowdown-*`) and mark chrome that the react package
// assumes are present — without it popovers/handles look unstyled and some
// mark affordances never paint. Order: core first, then react.
import '@meowdown/core/style.css';
import '@meowdown/react/style.css';
// meowdown's stylesheet is editor chrome only; the list layout (marker in its
// own box beside the content) lives in prosemirror-flat-list, which meowdown
// uses but does not re-export. Declared as a direct dependency rather than
// imported through the hoisted transitive so the resolution is real.
import 'prosemirror-flat-list/dist/style.css';

const IDLE_COMMIT_MS = 1200;

type PendingBodyCommit = {
  body: string;
  base: string;
  failed: boolean;
};

/**
 * Prose styling for the editing surface.
 *
 * Tailwind's preflight flattens `h1`-`h6` to inherited size and weight, and
 * meowdown ships no typography of its own (its stylesheet is editor chrome:
 * carets, menus, selection). Without this the document parses correctly and
 * renders as one undifferentiated wall of 14px text — structure present,
 * hierarchy invisible.
 *
 * These selectors deliberately do NOT reuse `MARKDOWN_BASE_CLASSNAME` from the
 * read-only renderer: that string is written against Streamdown's DOM
 * (`.contains-task-list`, `[data-streamdown=...]`, `[&>p]:inline` on list
 * items), while ProseMirror emits `div.prosemirror-flat-list` with separate
 * `.list-marker` / `.list-content` children. Sharing the string would apply
 * selectors that never match and miss the ones that do; matching the *look* is
 * the goal, not sharing the literal.
 */
/**
 * Host prose overrides. Meowdown wraps its own rules in `@layer meowdown`, and
 * un-layered host rules always win (official styling note in
 * `@meowdown/core` README) — so these keep body copy at app `text-sm` scale
 * instead of meowdown's default 1.0625rem note-page type.
 *
 * Horizontal padding is **not** set here: meowdown applies
 * `--meowdown-gutter` on `.meowdown-content` so the block-handle drag preview
 * stays unpadded. Override that variable on the host wrapper instead of
 * padding `.ProseMirror` yourself.
 */
const TASK_BODY_PROSE_CLASSNAME =
  '[&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[3rem] text-sm ' +
  '[&_.ProseMirror]:text-sm [&_.ProseMirror]:leading-relaxed ' +
  // Compact vertical chrome: task descriptions are not full notes.
  '[&_.meowdown-content]:pt-1 [&_.meowdown-content]:pb-2 ' +
  '[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:tracking-tight ' +
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:tracking-tight ' +
  '[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold ' +
  '[&_h4]:mt-3 [&_h4]:mb-1.5 [&_h4]:text-sm [&_h4]:font-semibold ' +
  '[&_h5]:mt-3 [&_h5]:mb-1 [&_h5]:text-xs [&_h5]:font-semibold [&_h5]:uppercase [&_h5]:tracking-wide ' +
  '[&_h6]:mt-3 [&_h6]:mb-1 [&_h6]:text-xs [&_h6]:font-semibold [&_h6]:uppercase [&_h6]:tracking-wide [&_h6]:text-muted-foreground ' +
  '[&_:is(h1,h2,h3,h4,h5,h6):first-child]:mt-0 ' +
  '[&_p]:my-1.5 [&_p:first-child]:mt-0 ' +
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground ' +
  '[&_hr]:my-3 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-border ' +
  '[&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-muted-foreground/40 ' +
  '[&_.prosemirror-flat-list]:my-1 [&_.prosemirror-flat-list_.list-content>p]:my-0 ' +
  '[&_.prosemirror-flat-list_.list-marker]:text-muted-foreground ' +
  // Flush top-level task items are a real stylesheet rule in `index.css`
  // (`.task-body-editor .meowdown-content > …`) — the equivalent arbitrary
  // variant compiles to nothing. See the comment there.
  '[&_.prosemirror-flat-list[data-list-kind=task]>.list-marker]:pr-1.5 ' +
  '[&_pre]:my-2 [&_pre]:rounded-md [&_pre]:bg-muted/60 [&_pre]:p-3 [&_pre]:text-xs ' +
  '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted/60 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.9em] ' +
  '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse ' +
  '[&_:is(th,td)]:border [&_:is(th,td)]:border-border/60 [&_:is(th,td)]:px-2 [&_:is(th,td)]:py-1 [&_th]:bg-muted/45 [&_th]:font-semibold ' +
  // Default meowdown grip is 1.25rem; pin to ~14px via stable testids.
  '[&_[data-testid=block-handle-drag]]:h-4 [&_[data-testid=block-handle-drag]]:w-3.5 ' +
  '[&_[data-testid=block-handle-drag]_svg]:h-3.5 [&_[data-testid=block-handle-drag]_svg]:w-3.5';

/**
 * Official theming surface: override `--meowdown-*` on an ancestor
 * (`@meowdown/core` README). Values map onto the app design tokens so menus,
 * carets, and marks follow light/dark without depending on meowdown's
 * `light-dark()` defaults alone.
 *
 * `--meowdown-gutter` pads `.meowdown-content` (not `.ProseMirror`). Official
 * default is 3.5rem for note-page chrome; task descriptions are denser, and
 * with the shrunken block handle 1.25rem is enough room for the grip.
 */
const TASK_BODY_THEME_CLASSNAME = [
  '[--meowdown-text:hsl(var(--foreground))]',
  '[--meowdown-heading:hsl(var(--foreground))]',
  '[--meowdown-muted:hsl(var(--muted-foreground))]',
  '[--meowdown-accent:hsl(var(--primary))]',
  '[--meowdown-caret:hsl(var(--primary))]',
  '[--meowdown-mark:hsl(var(--muted-foreground))]',
  '[--meowdown-border:hsl(var(--border))]',
  '[--meowdown-hr:hsl(var(--border))]',
  '[--meowdown-table-border:hsl(var(--border))]',
  '[--meowdown-code-bg:hsl(var(--muted))]',
  '[--meowdown-popover-bg:hsl(var(--popover))]',
  // `--accent` is not an app token; hover matches list/menu highlight.
  '[--meowdown-popover-hover-bg:hsl(var(--hover))]',
  // Full muted (not /0.55): on Vesper-dark the halved alpha made the empty-
  // state "Add description…" nearly invisible against the near-black canvas.
  '[--meowdown-placeholder:hsl(var(--muted-foreground))]',
  '[--meowdown-bullet:hsl(var(--muted-foreground))]',
  '[--meowdown-selection:hsl(var(--primary)/0.2)]',
  '[--meowdown-node-outline:hsl(var(--primary)/0.45)]',
  '[--meowdown-node-selection:hsl(var(--primary)/0.12)]',
  // 0, not the note-page default: the description has to start on the same x
  // as the title above it, and any gutter inset it by exactly that much. The
  // block handle still has room — it renders in the column's own `px-8`.
  '[--meowdown-gutter:0rem]',
  // Follow the host color scheme so any remaining light-dark() tokens resolve.
  'scheme-light dark:scheme-dark',
].join(' ');

/**
 * Task body editor: WYSIWYG editing over a Markdown document.
 *
 * Markdown stays the stored format so agents read and write the body with no
 * conversion — `lody_task_edit_body` matches against exactly what is persisted
 * here. What changed is only the editing surface: `**bold**` now renders as
 * bold while you type instead of showing its own syntax.
 *
 * The Loro text is the truth and this editor is a view of it, which makes the
 * two directions asymmetric:
 *
 * - **Local → Loro.** `onDocChange` fires only for user edits (never for our
 *   own `setState`), so there is no write loop. Commits are debounced to idle
 *   and flushed on blur, matching what the doc layer expects.
 * - **Loro → local.** `initialMarkdown` is read once at mount, so later remote
 *   edits must go through the handle. `setState(markdown)` without a selection
 *   maps the caret through the change rather than dropping it at the top —
 *   this is the whole reason the swap to meowdown was safe. Remote text is
 *   still only adopted while the user is NOT typing, so a collaborator cannot
 *   reflow the paragraph under someone's cursor mid-sentence.
 *
 * Selection menu (bold/italic/…) is host-supplied: meowdown only opens the
 * floating command UI when `onSelectionMenuSearch` is set. Omit it and the
 * selection affordance never appears — which is how this page first shipped.
 *
 * Default mark mode is **`hide`**: markdown syntax characters stay invisible
 * (`**bold**` renders as bold with no markers). Official modes are
 * `hide` | `focus` | `show`; the package default is `focus` (reveal near the
 * caret), which is noisier for a task description than a note-taking surface.
 */
export default function TaskBodyEditorSurface({
  value,
  disabled = false,
  onCommit,
  onQuoteSelection,
  onImagePaste,
  imageAccept,
}: TaskBodyEditorProps) {
  const { t } = useTranslation();
  const handleRef = useRef<EditorHandle | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editing, setEditing] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const { resolveImageUrl, cacheVersion } = useTaskImageResolver(value);
  const latestValueRef = useRef(value);
  const latestOnCommitRef = useRef(onCommit);
  const latestTRef = useRef(t);
  const editingRef = useRef(false);
  const pendingCommitRef = useRef<PendingBodyCommit | null>(null);
  latestValueRef.current = value;
  latestOnCommitRef.current = onCommit;
  latestTRef.current = t;

  // While the caret is in here, editor keys win over app shortcuts — ⌘B is bold,
  // not "toggle sidebar". Declared without `claims` because a rich text editor
  // owns far more keys than it is practical to enumerate; the few commands that
  // must survive typing (the palette) opt in with `allowInTextInput`.
  useKeyScope('task-body-editor', editorContainerRef);

  // What the document layer last told us, so we can tell a remote change apart
  // from the echo of our own commit coming back through the mirror.
  const lastSyncedRef = useRef(value);
  // Captured once: `initialMarkdown` is only read on the first render, and
  // re-reading `value` here would make a later remote edit look like an
  // initial value and quietly remount the document.
  const initialMarkdownRef = useRef(value);

  const flushCommit = useCallback((handle = handleRef.current, retryPending = false) => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (!handle) return;
    const next = handle.getMarkdown();
    const pending = pendingCommitRef.current;
    if (!pending && next === lastSyncedRef.current) return;
    // An idle timer and blur can land while the same asynchronous write is
    // still in flight. Do not issue it twice, but DO retry a rejected write.
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
        // A newer edit may already be saving, or the Loro echo may have
        // acknowledged this attempt synchronously. Never let an older promise
        // change the state of either one.
        if (pendingCommitRef.current !== attempt) return;
        // Success means the local write completed, but keep the pending guard
        // until that exact body comes back through the document subscription.
        // Clearing it here opens a small window where the previous (often
        // empty) prop can be mistaken for a newer remote edit.
        lastSyncedRef.current = next;
      },
      (error: unknown) => {
        if (pendingCommitRef.current !== attempt) return;
        // Keep the failed attempt as a dirty guard. A stale document snapshot
        // (commonly the empty body during reconnect) must not replace the
        // unsaved editor contents, and the next idle/blur/unmount can retry it.
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

  const handleDocChange = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = setTimeout(flushCommit, IDLE_COMMIT_MS);
  }, [flushCommit]);

  const adoptRemoteBody = useCallback((handle: EditorHandle | null, incoming: string) => {
    if (!handle) {
      return;
    }

    const pending = pendingCommitRef.current;
    if (pending) {
      if (incoming === pending.body) {
        pendingCommitRef.current = null;
        lastSyncedRef.current = incoming;
        return;
      }
      if (incoming === pending.base) {
        return;
      }
      if (pending.failed) {
        return;
      }
      pendingCommitRef.current = null;
    }

    if (
      !shouldAdoptRemoteBody({
        incoming,
        lastSynced: lastSyncedRef.current,
        editing: editingRef.current,
      })
    ) {
      return;
    }
    lastSyncedRef.current = incoming;
    handle.setState(incoming);
  }, []);

  /**
   * A callback ref closes two lifecycle gaps that an object ref cannot:
   *
   * - the task body can arrive after the editor rendered but before its
   *   imperative handle exists, so attaching the handle must replay the latest
   *   document value;
   * - closing or switching a task can unmount before the idle timer/blur fires,
   *   so detaching the handle must flush the current Markdown first.
   */
  const setEditorHandle = useCallback(
    (handle: EditorHandle | null) => {
      if (handle) {
        handleRef.current = handle;
        adoptRemoteBody(handle, latestValueRef.current);
        return;
      }

      const current = handleRef.current;
      if (!current) return;
      // Detaching loses the in-memory draft guard. Re-issue even an in-flight
      // body write so a rejected first attempt cannot disappear with the
      // editor; setting the same LoroText twice is idempotent at this boundary.
      flushCommit(current, true);
      const editor = current.editor;
      if (editor?.mounted) {
        editor.unmount();
      }
      handleRef.current = null;
    },
    [adoptRemoteBody, flushCommit]
  );

  // Adopt remote text only when it actually differs from what we last sent and
  // the user is not mid-edit. `setState` with no selection argument maps the
  // caret through the replacement; passing one would fight the user's cursor.
  useEffect(() => {
    adoptRemoteBody(handleRef.current, value);
  }, [adoptRemoteBody, editing, value]);

  useEffect(
    () => () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (cacheVersion > 0) {
      handleRef.current?.refreshMarkdownRendering();
    }
  }, [cacheVersion]);

  // meowdown owns its own DOM, so focus is observed on the wrapper rather than
  // through props the component does not expose.
  const handleFocusIn = useCallback(() => {
    editingRef.current = true;
    setEditing(true);
  }, []);
  const handleFocusOut = useCallback(() => {
    editingRef.current = false;
    setEditing(false);
    flushCommit();
  }, [flushCommit]);

  const refreshSelection = useCallback(() => {
    const handle = handleRef.current;
    setHasSelection(Boolean(handle && handle.getSelectedText().trim()));
  }, []);

  const handleQuote = useCallback(() => {
    const selected = handleRef.current?.getSelectedText().trim();
    if (selected && onQuoteSelection) {
      onQuoteSelection(selected);
    }
  }, [onQuoteSelection]);

  const handleFilePaste = useCallback(
    async (file: File): Promise<string | undefined> => {
      if (!onImagePaste) return undefined;
      try {
        return await onImagePaste(file);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t('tasks.images.uploadFailed', 'Upload failed')
        );
        return undefined;
      }
    },
    [onImagePaste, t]
  );

  // Formatting lives here, not inside meowdown: the selection menu is a host
  // command palette. Without this callback the floating affordance is disabled
  // entirely (`openSelectionMenu` becomes a no-op).

  return (
    <div className="group/body relative flex flex-col">
      {/* Quote only appears when there is a selection — a permanent "Quote
         selection" control in the empty description was chrome for no reason
         (Linear keeps the description surface itself quiet). The selection
         menu also exposes Quote when the host provides it. */}
      <div className="absolute right-0 top-0 z-[1] flex items-center gap-0.5">
        {onQuoteSelection && hasSelection ? (
          <Button variant="ghost" size="small" onClick={handleQuote}>
            <Quote className="h-3.5 w-3.5" />
            {t('tasks.body.quote', 'Quote selection')}
          </Button>
        ) : null}
      </div>

      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions --
         the editor inside owns keyboard interaction; these listeners only
         observe focus and selection on its container. */}
      <div
        ref={editorContainerRef}
        className={cn(
          // Description should read as body text under the title, not a form
          // field — no permanent border.
          'task-body-editor relative min-h-[3.5rem] rounded-md',
          TASK_BODY_THEME_CLASSNAME,
          TASK_BODY_PROSE_CLASSNAME
        )}
        onFocus={handleFocusIn}
        onBlur={handleFocusOut}
        onKeyUp={refreshSelection}
        onMouseUp={refreshSelection}
      >
        <MeowdownEditor
          handleRef={setEditorHandle}
          // Hide markdown source markers; rendered marks only. Package default
          // is `focus` (syntax peeks near the caret) — too chatty for Tasks.
          mode="hide"
          initialMarkdown={initialMarkdownRef.current}
          onDocChange={handleDocChange}
          readOnly={disabled}
          placeholder={t('tasks.body.placeholderShort', 'Add description…')}
          editorClassName="outline-none"
          resolveImageUrl={resolveImageUrl}
          onFilePaste={onImagePaste ? handleFilePaste : undefined}
        >
          {/* Rendered inside meowdown's ProseKit context, which is what lets it
             reach the editor commands and anchor to the live selection. */}
          <TaskBodySelectionToolbar {...(onQuoteSelection ? { onQuote: handleQuote } : {})} />
          {!disabled ? (
            <TaskBodyInsertMenu onImagePaste={onImagePaste} imageAccept={imageAccept} />
          ) : null}
        </MeowdownEditor>
      </div>
    </div>
  );
}
