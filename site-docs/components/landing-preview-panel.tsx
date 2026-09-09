'use client';

/**
 * LandingPreviewPanel — the session Browser panel for the DESIGN-MODE feature demo.
 *
 * Uses the REAL `SessionBrowserToolbar` (back / forward / reload / address bar /
 * annotate / share) over a mock page surface, mirroring `SessionBrowserPanel`
 * (packages/components/src/components/sessions/session-browser-panel.tsx), which
 * replaced the old `SessionPreviewPanel` — there is no Preview header, device
 * toolbar or dotted canvas any more; the page fills the panel like a browser tab.
 * The annotation hover box / draft card / saved comment still replicate the app's
 * visual annotation UI (@lody/shared visual-annotation-inspector styles +
 * VisualAnnotationDraftCard + visual-annotation-comments-overlay) driven by the
 * scripted demo state instead of postMessage.
 */

import { type ReactNode } from 'react';
import { Check, Send, SendHorizontal, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Textarea } from '@/ui/textarea';
import { SessionBrowserToolbar } from '@/components/sessions/session-browser-toolbar';
import { cn } from '@/lib/utils';

export type LandingPreviewDemoState = {
  loading: boolean;
  /** Annotation mode active (MessageCircle pressed + hover boxes live). */
  annotating: boolean;
  /** Index of the mock landing copy line the ghost cursor hovers (0..2). */
  hoverLine: number | null;
  /** Open draft comment card, anchored to a copy line. */
  draft: { line: number; text: string } | null;
  /** Saved comment (after "Add comment"): pin + white card. */
  savedComment: { line: number; text: string; staged: boolean } | null;
  /** Hot-reload applied: line 2 loses the "— desktop, browser, or phone." tail. */
  edited: boolean;
};

export const INITIAL_LANDING_PREVIEW_STATE: LandingPreviewDemoState = {
  loading: true,
  annotating: false,
  hoverLine: null,
  draft: null,
  savedComment: null,
  edited: false,
};

// The previewed dev server is the (English) Lody landing page.
const PAGE_LINES = [
  'Ship with parallel AI agents',
  'Every task runs in its own isolated git worktree.',
  'Conversations, diffs, and previews stay in sync — desktop, browser, or phone.',
];
const PAGE_LINE_2_EDITED = 'Conversations, diffs, and previews stay in sync.';

// Exact hover-highlight style from @lody/shared/visual-annotation-inspector.ts
// (border 2px rgba(37,99,235,.9), bg rgba(37,99,235,.08), radius 4px, 80ms ease).
const HOVER_BOX_STYLE: React.CSSProperties = {
  border: '2px solid rgba(37, 99, 235, 0.9)',
  background: 'rgba(37, 99, 235, 0.08)',
  borderRadius: '4px',
  transition: 'transform 80ms ease, width 80ms ease, height 80ms ease',
};

const BROWSER_ADDRESS = 'http://127.0.0.1:3002/';

export function LandingPreviewPanel({ state }: { state: LandingPreviewDemoState }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* The REAL toolbar; every control is inert here except annotation mode,
          which the scripted demo drives. */}
      <SessionBrowserToolbar
        address={BROWSER_ADDRESS}
        canGoBack={false}
        canGoForward={false}
        loading={state.loading}
        annotationEnabled={state.annotating}
        annotationAvailable
        sharing={false}
        shareAvailable
        hasShareUrl={false}
        busy={false}
        onAddressChange={() => undefined}
        onRestoreAddress={() => undefined}
        onNavigate={() => undefined}
        onBack={() => undefined}
        onForward={() => undefined}
        onReload={() => undefined}
        onStop={() => undefined}
        onToggleAnnotation={() => undefined}
        onShare={() => undefined}
        onStopSharing={() => undefined}
      />

      {/* The page fills the panel — the browser has no device canvas. */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
        {state.loading ? <MockPreviewLoading /> : <MockLandingSite state={state} />}
      </div>
    </div>
  );
}

function MockPreviewLoading() {
  // Mirrors PreviewLoadingOverlay: calm breathe on the Lody mark on white.
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-white">
      <img
        src="/landing/icon-transparent.png"
        alt=""
        aria-hidden
        className="h-16 w-16 animate-pulse select-none opacity-90"
        draggable={false}
      />
    </div>
  );
}

// ---- The previewed page: a mock Lody landing hero -----------------------------

function MockLandingSite({ state }: { state: LandingPreviewDemoState }) {
  const lines = [PAGE_LINES[0], PAGE_LINES[1], state.edited ? PAGE_LINE_2_EDITED : PAGE_LINES[2]];
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[linear-gradient(180deg,#071a2c_0%,#03090f_78%,#02060b_100%)] text-slate-100">
      {/* Mock site nav */}
      <div className="flex shrink-0 items-center justify-between px-6 py-4">
        <span className="flex items-center gap-2 text-sm font-semibold tracking-wide">
          <img src="/landing/icon-transparent.png" alt="" className="h-5 w-5" draggable={false} />
          Lody
        </span>
        <div className="flex items-center gap-4 text-xs text-slate-300/90">
          <span>Docs</span>
          <span>Pricing</span>
          <span className="rounded-md bg-sky-400/90 px-2.5 py-1 font-medium text-slate-950">
            Download
          </span>
        </div>
      </div>

      {/* Hero: the three copy lines the ghost cursor inspects. */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8 pb-10 text-center">
        <CopyLine index={0} state={state}>
          <h1 className="text-balance text-2xl font-bold leading-tight tracking-tight text-white sm:text-3xl">
            {lines[0]}
          </h1>
        </CopyLine>
        <CopyLine index={1} state={state}>
          <p className="text-pretty text-sm leading-6 text-slate-300 sm:text-base">{lines[1]}</p>
        </CopyLine>
        <CopyLine index={2} state={state}>
          <p className="text-pretty text-sm leading-6 text-slate-300 sm:text-base">{lines[2]}</p>
        </CopyLine>
        <div className="mt-3 flex items-center gap-3">
          <span className="rounded-lg bg-sky-400 px-4 py-2 text-sm font-semibold text-slate-950">
            Get started
          </span>
          <span className="rounded-lg border border-slate-500/60 px-4 py-2 text-sm font-medium text-slate-200">
            View docs
          </span>
        </div>
      </div>
    </div>
  );
}

// A hoverable copy line: relative wrapper hugging the text so the annotation
// hover box / draft card / saved pin anchor to the element rect (resize-proof).
function CopyLine({
  index,
  state,
  children,
}: {
  index: number;
  state: LandingPreviewDemoState;
  children: ReactNode;
}) {
  const hovered = state.hoverLine === index;
  const draft = state.draft?.line === index ? state.draft : null;
  const saved = state.savedComment?.line === index ? state.savedComment : null;
  return (
    <div className="relative w-fit max-w-full" data-demo={`pv-line-${index}`}>
      {children}
      {hovered || draft ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={HOVER_BOX_STYLE}
        />
      ) : null}
      {saved ? (
        // Anchor pin — visual-annotation-comments-overlay.tsx pin dot.
        <span
          aria-hidden
          className="absolute -left-4 top-1/2 z-30 block h-3 w-3 -translate-y-1/2 rounded-full bg-amber-500 ring-2 ring-background"
        />
      ) : null}
      {draft ? <DraftCommentCard text={draft.text} /> : null}
      {saved ? <SavedCommentCard text={saved.text} staged={saved.staged} /> : null}
    </div>
  );
}

// 1:1 with the annotation draft card in `sessions/managed-preview-surface.tsx`.
function DraftCommentCard({ text }: { text: string }) {
  return (
    <div
      data-demo="pv-draft"
      className="absolute left-6 top-[calc(100%+12px)] z-30 w-[280px] rounded-xl border border-border bg-popover p-3 text-left text-popover-foreground shadow-2xl"
    >
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold">Preview comment</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            p &quot;{PAGE_LINES[2].slice(0, 42)}&quot;
          </div>
        </div>
        <button
          type="button"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-hover hover:text-hover-foreground"
          aria-label="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <Textarea
        value={text}
        onChange={() => undefined}
        placeholder="Describe what should change here..."
        className="min-h-20 resize-none bg-background text-xs"
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="small">
          Cancel
        </Button>
        <Button type="button" data-demo="pv-draft-send" size="small" disabled={text.length === 0}>
          <Send className="h-3.5 w-3.5" />
          Add comment
        </Button>
      </div>
    </div>
  );
}

// Mirrors the open comment card in visual-annotation-comments-overlay.tsx, but
// uses app tokens so dark mode (landing default) stays legible on the mock page.
function SavedCommentCard({ text, staged }: { text: string; staged: boolean }) {
  return (
    <article className="absolute left-6 top-[calc(100%+12px)] z-30 w-[260px] overflow-hidden rounded-xl border border-border bg-popover text-left text-popover-foreground shadow-2xl">
      <div className="flex items-start gap-2.5 px-3 pt-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-600 text-[10px] font-semibold tracking-wide text-white"
        >
          LE
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-xs font-semibold leading-4 text-foreground">
            <span className="truncate">Leon</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
              Draft
            </span>
          </p>
          <p className="mt-1 whitespace-pre-line break-words text-[13px] leading-5 text-muted-foreground">
            {text}
          </p>
        </div>
        <button
          type="button"
          aria-label="Collapse comment"
          className="-mr-1 -mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-hover-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-1 border-t border-border px-1.5 py-1">
        <button
          type="button"
          data-demo="pv-comment-send"
          aria-pressed={staged}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
            staged
              ? 'text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400'
              : 'text-muted-foreground hover:bg-hover hover:text-hover-foreground'
          )}
        >
          {staged ? (
            <Check className="h-3 w-3" />
          ) : (
            <SendHorizontal className="h-3 w-3 -scale-x-100" />
          )}
          {staged ? 'Added' : 'Send'}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-emerald-600 transition-colors hover:bg-emerald-500/10 dark:text-emerald-400"
        >
          <Check className="h-3 w-3" />
          Resolve
        </button>
      </div>
    </article>
  );
}
