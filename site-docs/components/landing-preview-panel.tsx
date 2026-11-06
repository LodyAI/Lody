'use client';
import * as stylex from '@stylexjs/stylex';

/**
 * LandingPreviewPanel — the session Browser panel for the DESIGN-MODE feature demo.
 *
 * Uses a replica of the app's `SessionBrowserToolbar` (back / forward / reload /
 * address bar / annotate / share) over a mock page surface, mirroring `SessionBrowserPanel`
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
import { ReplicaBrowserToolbar } from './landing-replica/browser-toolbar';
import { Button } from './landing-replica/button';
const previewPulse = stylex.keyframes({ '50%': { opacity: 0.5 } });

const previewStyles = stylex.create({
  stack: {
    display: 'flex',
    height: '100%',
    'min-height': '0px',
    'flex-direction': 'column',
    'background-color': 'hsl(var(--background))',
  },
  section: {
    position: 'relative',
    'min-height': '0px',
    flex: '1',
    overflow: 'hidden',
    'background-color': 'var(--color-white)',
  },
  overlay: {
    position: 'absolute',
    inset: '0px',
    'z-index': '10',
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'center',
    'background-color': 'var(--color-white)',
  },
  frame: {
    height: 'calc(var(--spacing) * 16)',
    width: 'calc(var(--spacing) * 16)',
    animationName: previewPulse,
    animationDuration: '2s',
    animationTimingFunction: 'cubic-bezier(0.4, 0, 0.6, 1)',
    animationIterationCount: 'infinite',
    opacity: '90%',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  stack2: {
    display: 'flex',
    height: '100%',
    width: '100%',
    'flex-direction': 'column',
    overflow: 'hidden',
    'background-image': 'linear-gradient(180deg,#071a2c 0%,#03090f 78%,#02060b 100%)',
    color: 'var(--color-slate-100)',
  },
  row: {
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'space-between',
    'padding-inline': 'calc(var(--spacing) * 6)',
    'padding-block': 'calc(var(--spacing) * 4)',
  },
  row2: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
  },
  frame2: {
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
  },
  row3: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 4)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'color-mix(in oklab, var(--color-slate-300) 90%, transparent)',
  },
  text: {
    'border-radius': 'var(--radius-md)',
    'background-color': 'color-mix(in oklab, var(--color-sky-400) 90%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 2.5)',
    'padding-block': 'var(--spacing)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'var(--color-slate-950)',
  },
  stack3: {
    display: 'flex',
    'min-height': '0px',
    flex: '1',
    'flex-direction': 'column',
    'align-items': 'center',
    'justify-content': 'center',
    gap: 'calc(var(--spacing) * 4)',
    'padding-inline': 'calc(var(--spacing) * 8)',
    'padding-bottom': 'calc(var(--spacing) * 10)',
    'text-align': 'center',
  },
  text2: {
    'font-size': 'var(--text-2xl)',
    'line-height': 'var(--leading-tight)',
    'font-weight': 'var(--font-weight-bold)',
    'letter-spacing': 'var(--tracking-tight)',
    'text-wrap': 'balance',
    color: 'var(--color-white)',
    '@media (width >= 40rem)': {
      'font-size': 'var(--text-3xl)',
      'line-height': 'var(--leading-tight)',
    },
  },
  text3: {
    'font-size': 'var(--text-sm)',
    'line-height': 'calc(var(--spacing) * 6)',
    'text-wrap': 'pretty',
    color: 'var(--color-slate-300)',
    '@media (width >= 40rem)': {
      'font-size': 'var(--text-base)',
      'line-height': 'calc(var(--spacing) * 6)',
    },
  },
  row4: {
    'margin-top': 'calc(var(--spacing) * 3)',
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 3)',
  },
  text4: {
    'border-radius': 'var(--radius-lg)',
    'background-color': 'var(--color-sky-400)',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    color: 'var(--color-slate-950)',
  },
  text5: {
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, var(--color-slate-500) 60%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'var(--color-slate-200)',
  },
  frame3: {
    position: 'relative',
    width: 'fit-content',
    'max-width': '100%',
  },
  overlay2: {
    'pointer-events': 'none',
    position: 'absolute',
    inset: '0px',
  },
  overlay3: {
    position: 'absolute',
    top: 'calc(1 / 2 * 100%)',
    left: 'calc(var(--spacing) * -4)',
    'z-index': '30',
    display: 'block',
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
    translate: '0 calc(calc(1 / 2 * 100%) * -1)',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'var(--color-amber-500)',
    'box-shadow':
      '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 calc(2px + 0px) hsl(var(--background)), 0 0 #0000',
  },
  overlay4: {
    position: 'absolute',
    top: 'calc(100% + 12px)',
    left: 'calc(var(--spacing) * 6)',
    'z-index': '30',
    width: '280px',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--popover))',
    padding: 'calc(var(--spacing) * 3)',
    'text-align': 'left',
    color: 'hsl(var(--popover-foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
  },
  row5: {
    'margin-bottom': 'calc(var(--spacing) * 2)',
    display: 'flex',
    'align-items': 'flex-start',
    gap: 'calc(var(--spacing) * 2)',
  },
  section2: {
    'min-width': '0px',
    flex: '1',
  },
  text6: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
  },
  text7: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-family': 'var(--font-mono)',
    'font-size': '10px',
    color: 'hsl(var(--muted-foreground))',
  },
  row6: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'var(--radius-md)',
    color: 'hsl(var(--muted-foreground))',
    '@media (hover: hover)': {
      ':hover': {
        'background-color': 'hsl(var(--hover))',
        color: 'hsl(var(--hover-foreground))',
      },
    },
  },
  frame4: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
  row7: {
    display: 'flex',
    'min-height': 'calc(var(--spacing) * 20)',
    width: '100%',
    resize: 'none',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--input-border))',
    'background-color': 'hsl(var(--background))',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--input-foreground))',
    '::placeholder': {
      color: 'hsl(var(--input-placeholder))',
    },
    ':focus-visible': {
      'box-shadow':
        '0 0 #0000, 0 0 #0000, 0 0 0 0px hsl(var(--background)), 0 0 0 calc(0px + 0px) currentcolor, 0 0 #0000',
      'outline-style': 'none',
    },
    ':disabled': {
      cursor: 'not-allowed',
      'background-color': 'hsl(var(--muted))',
      opacity: '60%',
    },
  },
  row8: {
    'margin-top': 'calc(var(--spacing) * 2)',
    display: 'flex',
    'justify-content': 'flex-end',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  overlay5: {
    position: 'absolute',
    top: 'calc(100% + 12px)',
    left: 'calc(var(--spacing) * 6)',
    'z-index': '30',
    width: '260px',
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--popover))',
    'text-align': 'left',
    color: 'hsl(var(--popover-foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
  },
  row9: {
    display: 'flex',
    'align-items': 'flex-start',
    gap: 'calc(var(--spacing) * 2.5)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-top': 'calc(var(--spacing) * 3)',
  },
  row10: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'var(--color-sky-600)',
    'font-size': '10px',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'var(--color-white)',
  },
  row11: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'font-size': 'var(--text-xs)',
    'line-height': 'calc(var(--spacing) * 4)',
    'font-weight': 'var(--font-weight-semibold)',
    color: 'hsl(var(--foreground))',
  },
  section3: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  row12: {
    display: 'inline-flex',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'color-mix(in oklab, var(--color-amber-500) 15%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
    'padding-block': 'calc(var(--spacing) * 0.5)',
    'font-size': '9px',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'var(--color-amber-700)',
    'text-transform': 'uppercase',
    ':where(.dark, .dark *)': {
      color: 'var(--color-amber-400)',
    },
  },
  text8: {
    'margin-top': 'var(--spacing)',
    'font-size': '13px',
    'line-height': 'calc(var(--spacing) * 5)',
    'overflow-wrap': 'break-word',
    'white-space': 'pre-line',
    color: 'hsl(var(--muted-foreground))',
  },
  row13: {
    'margin-top': 'calc(var(--spacing) * -0.5)',
    'margin-right': 'calc(var(--spacing) * -1)',
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'var(--radius-md)',
    color: 'hsl(var(--muted-foreground))',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '@media (hover: hover)': {
      ':hover': {
        'background-color': 'hsl(var(--hover))',
        color: 'hsl(var(--hover-foreground))',
      },
    },
  },
  row14: {
    'margin-top': 'calc(var(--spacing) * 2)',
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'space-between',
    gap: 'var(--spacing)',
    'border-top-style': 'solid',
    'border-top-width': '1px',
    'border-color': 'hsl(var(--border))',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
    'padding-block': 'var(--spacing)',
  },
  row15: {
    display: 'inline-flex',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'var(--spacing)',
    'font-size': '11px',
    'font-weight': 'var(--font-weight-medium)',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
  },
  text9: {
    color: 'var(--color-emerald-600)',
    '@media (hover: hover)': {
      ':hover': {
        'background-color': 'color-mix(in oklab, var(--color-emerald-500) 10%, transparent)',
      },
    },
    ':where(.dark, .dark *)': {
      color: 'var(--color-emerald-400)',
    },
  },
  text10: {
    color: 'hsl(var(--muted-foreground))',
    '@media (hover: hover)': {
      ':hover': {
        'background-color': 'hsl(var(--hover))',
        color: 'hsl(var(--hover-foreground))',
      },
    },
  },
  frame5: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
  },
  frame6: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
    scale: 'calc(100% * -1) 1',
  },
  row16: {
    display: 'inline-flex',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'var(--spacing)',
    'font-size': '11px',
    'font-weight': 'var(--font-weight-medium)',
    color: 'var(--color-emerald-600)',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '@media (hover: hover)': {
      ':hover': {
        'background-color': 'color-mix(in oklab, var(--color-emerald-500) 10%, transparent)',
      },
    },
    ':where(.dark, .dark *)': {
      color: 'var(--color-emerald-400)',
    },
  },
});

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
    <div data-power-demo-layout="inset-fill" {...stylex.props(previewStyles.stack)}>
      {/* Toolbar replica; only annotation mode changes, driven by the demo. */}
      <ReplicaBrowserToolbar
        address={BROWSER_ADDRESS}
        loading={state.loading}
        annotating={state.annotating}
      />

      {/* The page fills the panel — the browser has no device canvas. */}
      <div {...stylex.props(previewStyles.section)}>
        {state.loading ? <MockPreviewLoading /> : <MockLandingSite state={state} />}
      </div>
    </div>
  );
}

function MockPreviewLoading() {
  // Mirrors PreviewLoadingOverlay: calm breathe on the Lody mark on white.
  return (
    <div {...stylex.props(previewStyles.overlay)}>
      <img
        src="/landing/icon-transparent.png"
        alt=""
        aria-hidden
        {...stylex.props(previewStyles.frame)}
        draggable={false}
      />
    </div>
  );
}

// ---- The previewed page: a mock Lody landing hero -----------------------------

function MockLandingSite({ state }: { state: LandingPreviewDemoState }) {
  const lines = [PAGE_LINES[0], PAGE_LINES[1], state.edited ? PAGE_LINE_2_EDITED : PAGE_LINES[2]];
  return (
    <div {...stylex.props(previewStyles.stack2)}>
      {/* Mock site nav */}
      <div {...stylex.props(previewStyles.row)}>
        <span {...stylex.props(previewStyles.row2)}>
          <img
            src="/landing/icon-transparent.png"
            alt=""
            {...stylex.props(previewStyles.frame2)}
            draggable={false}
          />
          Lody
        </span>
        <div {...stylex.props(previewStyles.row3)}>
          <span>Docs</span>
          <span>Pricing</span>
          <span {...stylex.props(previewStyles.text)}>Download</span>
        </div>
      </div>

      {/* Hero: the three copy lines the ghost cursor inspects. */}
      <div {...stylex.props(previewStyles.stack3)}>
        <CopyLine index={0} state={state}>
          <h2 {...stylex.props(previewStyles.text2)}>{lines[0]}</h2>
        </CopyLine>
        <CopyLine index={1} state={state}>
          <p {...stylex.props(previewStyles.text3)}>{lines[1]}</p>
        </CopyLine>
        <CopyLine index={2} state={state}>
          <p {...stylex.props(previewStyles.text3)}>{lines[2]}</p>
        </CopyLine>
        <div {...stylex.props(previewStyles.row4)}>
          <span {...stylex.props(previewStyles.text4)}>Get started</span>
          <span {...stylex.props(previewStyles.text5)}>View docs</span>
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
    <div {...stylex.props(previewStyles.frame3)} data-demo={`pv-line-${index}`}>
      {children}
      {hovered || draft ? (
        <span aria-hidden {...stylex.props(previewStyles.overlay2)} style={HOVER_BOX_STYLE} />
      ) : null}
      {saved ? (
        // Anchor pin — visual-annotation-comments-overlay.tsx pin dot.
        <span aria-hidden {...stylex.props(previewStyles.overlay3)} />
      ) : null}
      {draft ? <DraftCommentCard text={draft.text} /> : null}
      {saved ? <SavedCommentCard text={saved.text} staged={saved.staged} /> : null}
    </div>
  );
}

// 1:1 with the annotation draft card in `sessions/managed-preview-surface.tsx`.
function DraftCommentCard({ text }: { text: string }) {
  return (
    <div data-demo="pv-draft" {...stylex.props(previewStyles.overlay4)}>
      <div {...stylex.props(previewStyles.row5)}>
        <div {...stylex.props(previewStyles.section2)}>
          <div {...stylex.props(previewStyles.text6)}>Preview comment</div>
          <div {...stylex.props(previewStyles.text7)}>
            p &quot;{PAGE_LINES[2].slice(0, 42)}&quot;
          </div>
        </div>
        <button type="button" {...stylex.props(previewStyles.row6)} aria-label="Cancel">
          <X {...stylex.props(previewStyles.frame4)} />
        </button>
      </div>
      {/* The app's `ui/textarea` classes merged with the card's overrides. */}
      <textarea
        value={text}
        readOnly
        placeholder="Describe what should change here..."
        {...stylex.props(previewStyles.row7)}
      />
      <div {...stylex.props(previewStyles.row8)}>
        <Button type="button" size="sm" variant="ghost">
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          data-demo="pv-draft-send"
          disabled={text.length === 0}
          iconSize="calc(var(--spacing) * 3.5)"
        >
          <Send />
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
    <article {...stylex.props(previewStyles.overlay5)}>
      <div {...stylex.props(previewStyles.row9)}>
        <span aria-hidden {...stylex.props(previewStyles.row10)}>
          LE
        </span>
        <div {...stylex.props(previewStyles.section2)}>
          <p {...stylex.props(previewStyles.row11)}>
            <span {...stylex.props(previewStyles.section3)}>Leon</span>
            <span {...stylex.props(previewStyles.row12)}>Draft</span>
          </p>
          <p {...stylex.props(previewStyles.text8)}>{text}</p>
        </div>
        <button type="button" aria-label="Collapse comment" {...stylex.props(previewStyles.row13)}>
          <X {...stylex.props(previewStyles.frame4)} />
        </button>
      </div>
      <div {...stylex.props(previewStyles.row14)}>
        <button
          type="button"
          data-demo="pv-comment-send"
          aria-pressed={staged}
          {...stylex.props(
            previewStyles.row15,
            staged ? previewStyles.text9 : previewStyles.text10
          )}
        >
          {staged ? (
            <Check {...stylex.props(previewStyles.frame5)} />
          ) : (
            <SendHorizontal {...stylex.props(previewStyles.frame6)} />
          )}
          {staged ? 'Added' : 'Send'}
        </button>
        <button type="button" {...stylex.props(previewStyles.row16)}>
          <Check {...stylex.props(previewStyles.frame5)} />
          Resolve
        </button>
      </div>
    </article>
  );
}
