import * as stylex from '@stylexjs/stylex';
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Check, MousePointer2, RefreshCw, SendHorizontal, Trash2, X } from 'lucide-react';
import {
  RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE,
  SET_ANNOTATION_MODE_MESSAGE_TYPE,
  VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE,
  VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE,
  createMinimalVisualAnnotationAnchor,
  createVisualCommentInspector,
} from '@lody/shared/visual-annotation-inspector';
import {
  createPreviewVisualComment,
  createVisualAnnotationReferenceFromPreviewComment,
  getPreviewCommentRoomId,
} from '@lody/shared/preview-comment-types';
import type { PreviewVisualComment } from '@lody/shared/preview-comment-types';
import type { SessionId, SessionInputBlock } from '@lody/shared';
import type {
  VisualAnnotationInspectPayload,
  VisualAnnotationAnchorsResolvedMessage,
  VisualAnnotationResolvedAnchor,
  VisualAnnotationTargetMessage,
  VisualCommentInspector,
} from '@lody/shared/visual-annotation-inspector';
import { VisualAnnotationCommentsOverlay } from '@/components/preview/visual-annotation-comments-overlay';
import { VisualAnnotationReferenceCard } from '@/components/ai-gui/visual-annotation-reference-card';
import { Button } from '@lody/ui/button';
import { Textarea } from '@lody/ui/textarea';

const storyStyles = stylex.create({
  harness: {
    minHeight: '820px',
    backgroundColor: 'var(--color-slate-100)',
    padding: 'calc(var(--spacing) * 6)',
    color: 'var(--color-slate-900)',
  },
  workspace: {
    marginInline: 'auto',
    display: 'grid',
    maxWidth: '1440px',
    gap: 'calc(var(--spacing) * 5)',
    gridTemplateColumns: {
      default: null,
      '@media (width >= 80rem)': 'minmax(0,1fr) 380px',
    },
  },
  previewPanel: {
    overflow: 'hidden',
    borderRadius: 'var(--radius-2xl)',
    backgroundColor: 'var(--color-white)',
    padding: 'calc(var(--spacing) * 4)',
    boxShadow: '0 0 0 1px var(--color-slate-200), 0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  previewToolbar: {
    marginBottom: 'calc(var(--spacing) * 3)',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'calc(var(--spacing) * 3)',
  },
  eyebrow: {
    fontSize: '11px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.18em',
    color: 'var(--color-slate-500)',
  },
  panelTitle: {
    marginTop: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-base)',
    lineHeight: 'var(--text-base--line-height)',
    fontWeight: '600',
    color: 'var(--color-slate-900)',
  },
  deviceSwitcher: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'var(--color-slate-100)',
    padding: 'calc(var(--spacing) * 0.5)',
  },
  previewWell: {
    overflow: 'auto',
    borderRadius: 'var(--radius-xl)',
    backgroundColor: 'color-mix(in oklab, var(--color-slate-200) 60%, transparent)',
    padding: 'calc(var(--spacing) * 4)',
    boxShadow: '0 0 0 1px var(--color-slate-200)',
  },
  previewViewport: {
    position: 'relative',
    marginInline: 'auto',
  },
  previewFrame: {
    display: 'block',
    height: '100%',
    width: '100%',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'var(--color-white)',
    boxShadow: '0 0 0 1px var(--color-slate-200), 0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  controlsPanel: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 4)',
    },
    borderRadius: 'var(--radius-2xl)',
    backgroundColor: 'var(--color-white)',
    padding: 'calc(var(--spacing) * 4)',
    boxShadow: '0 0 0 1px var(--color-slate-200), 0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  controlsHeading: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 'calc(var(--spacing) * 3)',
  },
  glyph: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
  twoColumns: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 'calc(var(--spacing) * 2)',
  },
  metadataPanel: {
    borderRadius: 'var(--radius-xl)',
    backgroundColor: 'var(--color-slate-50)',
    padding: 'calc(var(--spacing) * 3)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    boxShadow: '0 0 0 1px var(--color-slate-200)',
  },
  metadataGrid: {
    display: 'grid',
    gridTemplateColumns: '64px minmax(0,1fr)',
    rowGap: 'calc(var(--spacing) * 1.5)',
  },
  mutedText: {
    color: 'var(--color-slate-500)',
  },
  documentId: {
    wordBreak: 'break-all',
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    color: 'var(--color-slate-700)',
  },
  inspectorPanel: {
    borderRadius: 'var(--radius-xl)',
    backgroundColor: 'var(--color-slate-50)',
    padding: 'calc(var(--spacing) * 3)',
    boxShadow: '0 0 0 1px var(--color-slate-200)',
  },
  sectionHeading: {
    marginBottom: 'calc(var(--spacing) * 2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'calc(var(--spacing) * 2)',
  },
  sectionTitle: {
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: '600',
    color: 'var(--color-slate-900)',
  },
  targetBadge: {
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: 'var(--color-white)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 0.5)',
    fontSize: '11px',
    fontWeight: '500',
    color: 'var(--color-slate-600)',
    boxShadow: '0 0 0 1px var(--color-slate-200)',
  },
  targetEditor: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 3)',
    },
  },
  targetSelector: {
    wordBreak: 'break-all',
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontSize: '11px',
    color: 'var(--color-slate-600)',
  },
  commentInput: {
    minHeight: 'calc(var(--spacing) * 20)',
    backgroundColor: 'var(--color-white)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
  },
  fullWidth: {
    width: '100%',
  },
  instructions: {
    fontSize: 'var(--text-xs)',
    lineHeight: '1.625',
    color: 'var(--color-slate-500)',
  },
  pendingBadge: {
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: 'var(--color-amber-100)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 0.5)',
    fontSize: '11px',
    fontWeight: '500',
    color: 'var(--color-amber-700)',
  },
  commentsList: {
    maxHeight: '240px',
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 1.5)',
    },
    overflow: 'auto',
    paddingRight: 'calc(var(--spacing) * 1)',
  },
  commentText: {
    minWidth: 0,
    flex: '1',
  },
  commentBody: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: '500',
    color: 'var(--color-slate-900)',
  },
  commentTarget: {
    marginTop: 'calc(var(--spacing) * 0.5)',
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '10px',
    color: 'var(--color-slate-500)',
  },
  emptyComments: {
    paddingInline: 'calc(var(--spacing) * 1)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    fontSize: 'var(--text-xs)',
    lineHeight: '1.625',
    color: 'var(--color-slate-500)',
  },
  commentActions: {
    marginTop: 'calc(var(--spacing) * 2)',
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 'calc(var(--spacing) * 2)',
  },
  stagedBadge: {
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: 'var(--color-sky-100)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 0.5)',
    fontSize: '11px',
    fontWeight: '500',
    color: 'var(--color-sky-700)',
  },
  draftStack: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 2)',
    },
  },
  referenceList: {
    maxHeight: '220px',
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 2)',
    },
    overflow: 'auto',
    paddingRight: 'calc(var(--spacing) * 1)',
  },
  referenceRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0,1fr) auto',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'var(--color-white)',
    padding: 'calc(var(--spacing) * 2)',
    boxShadow: '0 0 0 1px var(--color-slate-200), 0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  referenceCard: {
    maxWidth: 'none',
  },
  sentBadge: {
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: 'var(--color-slate-100)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 0.5)',
    fontSize: '11px',
    fontWeight: '500',
    color: 'var(--color-slate-600)',
    boxShadow: '0 0 0 1px var(--color-slate-200)',
  },
  sentReference: {
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'var(--color-white)',
    padding: 'calc(var(--spacing) * 2)',
    boxShadow: '0 0 0 1px var(--color-slate-200), 0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  referenceLabel: {
    marginBottom: 'calc(var(--spacing) * 1.5)',
    fontSize: '10px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.16em',
    color: 'var(--color-slate-400)',
  },
  deviceButton: {
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    fontWeight: '500',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    transitionDuration: 'var(--default-transition-duration)',
  },
  selectedDevice: {
    backgroundColor: 'var(--color-white)',
    color: 'var(--color-slate-900)',
    boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  idleDevice: {
    color: {
      default: 'var(--color-slate-500)',
      '@media (hover: hover)': {
        ':hover': 'var(--color-slate-700)',
      },
    },
  },
  commentRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'flex-start',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-lg)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    textAlign: 'left',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    transitionDuration: 'var(--default-transition-duration)',
  },
  selectedComment: {
    backgroundColor: 'var(--color-white)',
    boxShadow: '0 0 0 1px var(--color-slate-300), 0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  idleComment: {
    backgroundColor: {
      default: null,
      '@media (hover: hover)': {
        ':hover': 'color-mix(in oklab, var(--color-white) 70%, transparent)',
      },
    },
  },
  statusDot: {
    marginTop: 'calc(var(--spacing) * 1)',
    height: 'calc(var(--spacing) * 2)',
    width: 'calc(var(--spacing) * 2)',
    flexShrink: 0,
    borderRadius: 'calc(infinity * 1px)',
  },
  submittedDot: {
    backgroundColor: 'var(--color-slate-400)',
  },
  stagedDot: {
    backgroundColor: 'var(--color-sky-500)',
  },
  resolvedDot: {
    backgroundColor: 'var(--color-emerald-500)',
  },
  pendingDot: {
    backgroundColor: 'var(--color-amber-500)',
  },
});

const storySessionId = 'session-storybook-visual-annotation' as SessionId;
const storyTurnId = 'turn-storybook-visual-annotation';
const storyAuthorId = 'storybook-user';
const storyAuthorName = 'Storybook User';
const storyRoomId = getPreviewCommentRoomId(storySessionId);

const devices = [
  { id: 'desktop', label: 'Desktop', width: 960, height: 620 },
  { id: 'mobile', label: 'Mobile', width: 390, height: 720 },
] as const;

type DeviceId = (typeof devices)[number]['id'];
type VisualAnnotationReferenceInputBlock = Extract<
  SessionInputBlock,
  { type: 'visual_annotation_reference' }
>;

const previewSrcDoc = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Local Preview Fixture</title>
    <style>
      :root {
        color: #0f172a;
        background: #ffffff;
        font-family:
          -apple-system,
          BlinkMacSystemFont,
          "Inter",
          system-ui,
          sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 1320px;
        background: #ffffff;
      }

      .shell {
        display: grid;
        gap: 28px;
        padding: 40px 40px 520px;
      }

      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1.1fr) minmax(260px, 0.9fr);
        gap: 28px;
        align-items: stretch;
      }

      .hero-copy {
        padding: 36px;
        border-radius: 20px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
      }

      .eyebrow {
        margin: 0 0 12px;
        color: #64748b;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }

      h1 {
        max-width: 780px;
        margin: 0;
        font-family: "Times New Roman", Georgia, serif;
        font-size: clamp(36px, 7vw, 72px);
        line-height: 0.95;
        letter-spacing: -0.04em;
        color: #0f172a;
      }

      .hero-copy p {
        max-width: 560px;
        margin: 18px 0 0;
        color: #475569;
        font-size: 15px;
        line-height: 1.65;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 24px;
      }

      button,
      a.button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-height: 38px;
        border: 0;
        border-radius: 999px;
        padding: 0 18px;
        color: #ffffff;
        background: #0f172a;
        font: inherit;
        font-weight: 600;
        font-size: 13px;
        text-decoration: none;
        cursor: pointer;
      }

      button.secondary {
        color: #0f172a;
        background: #f1f5f9;
      }

      .panel {
        display: grid;
        align-content: space-between;
        min-height: 320px;
        padding: 28px;
        border-radius: 20px;
        background: #0f172a;
        color: #f8fafc;
      }

      .metric {
        display: grid;
        gap: 6px;
      }

      .metric span {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: #94a3b8;
      }

      .metric strong {
        font-size: 48px;
        font-weight: 600;
        letter-spacing: -0.04em;
      }

      .panel p {
        margin: 0;
        color: #cbd5e1;
        font-size: 14px;
        line-height: 1.55;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 16px;
      }

      .card {
        padding: 22px;
        border-radius: 16px;
        background: #ffffff;
        border: 1px solid #e2e8f0;
      }

      .card h2 {
        margin: 0 0 8px;
        font-size: 15px;
        color: #0f172a;
      }

      .card p,
      label {
        margin: 0;
        color: #64748b;
        font-size: 13px;
        line-height: 1.55;
      }

      form {
        display: grid;
        gap: 10px;
      }

      input {
        width: 100%;
        height: 38px;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        padding: 0 12px;
        color: #0f172a;
        background: #ffffff;
        font: inherit;
        font-size: 13px;
      }

      .below-fold {
        display: grid;
        grid-template-columns: minmax(0, 1.35fr) minmax(220px, 0.65fr);
        gap: 16px;
        margin-top: 420px;
      }

      .audit-card {
        padding: 26px;
        border-radius: 18px;
        background: #f8fafc;
        border: 1px solid #dbe3ee;
      }

      .audit-card h2 {
        margin: 0 0 10px;
        font-size: 20px;
        color: #0f172a;
      }

      .audit-card p {
        margin: 0;
        color: #475569;
        font-size: 14px;
        line-height: 1.6;
      }

      @media (max-width: 680px) {
        .shell {
          padding: 22px;
        }

        .hero,
        .grid,
        .below-fold {
          grid-template-columns: 1fr;
        }

        .hero-copy {
          padding: 24px;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero" data-testid="marketing-hero">
        <div class="hero-copy">
          <p class="eyebrow">Preview fixture</p>
          <h1>Design reviews should point at pixels.</h1>
          <p>
            This iframe behaves like a tunneled preview page. Enable annotation mode in the
            parent panel, hover elements, then click a card, button, input, or SVG icon.
          </p>
          <div class="actions">
            <button data-testid="primary-cta" aria-label="Start visual review">
              <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
                <path d="M2 9h11M9 5l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" />
              </svg>
              Start review
            </button>
            <button class="secondary" role="button" data-cy="secondary-action">
              Open changelog
            </button>
          </div>
        </div>
        <aside class="panel" role="complementary" aria-label="Release health">
          <div class="metric">
            <span>Review confidence</span>
            <strong>94%</strong>
          </div>
          <p>Selectors, text snippets, rect ratios, and nearby context are captured for AI.</p>
        </aside>
      </section>

      <section class="grid" aria-label="Inspector targets">
        <article class="card" data-testid="spacing-card">
          <h2>Spacing regression</h2>
          <p>The toolbar gap feels too wide when the viewport switches to mobile.</p>
        </article>
        <article class="card" data-testid="copy-card">
          <h2>Ambiguous copy</h2>
          <p>Click this copy block to inspect ancestor summaries and nearby text.</p>
        </article>
        <form class="card" data-testid="signup-form">
          <h2>Signup form</h2>
          <label for="email">Email address</label>
          <input id="email" name="email" type="email" value="designer@example.test" />
          <button type="submit" data-testid="submit-email">Send invite</button>
        </form>
      </section>

      <section class="below-fold" aria-label="Scrolled inspector targets">
        <article class="audit-card" data-testid="below-fold-audit-card">
          <h2>Below-fold QA checkpoint</h2>
          <p>
            This section sits far enough down the iframe to debug comments whose anchors leave the
            visible preview viewport during scroll.
          </p>
        </article>
        <button class="secondary" data-testid="below-fold-action">Review later</button>
      </section>
    </main>
  </body>
</html>`;

const isVisualAnnotationTargetMessage = (
  value: unknown
): value is VisualAnnotationTargetMessage => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (value as { type?: unknown }).type === VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE;
};

const isVisualAnnotationAnchorsResolvedMessage = (
  value: unknown
): value is VisualAnnotationAnchorsResolvedMessage => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (value as { type?: unknown }).type === VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE;
};

function VisualAnnotationInspectorHarness() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const inspectorRef = useRef<VisualCommentInspector | null>(null);
  const [deviceId, setDeviceId] = useState<DeviceId>('desktop');
  const [annotationMode, setAnnotationMode] = useState(false);
  const [selectedPayload, setSelectedPayload] = useState<VisualAnnotationInspectPayload | null>(
    null
  );
  const [draftBody, setDraftBody] = useState('This element needs a tighter mobile layout.');
  const [comments, setComments] = useState<PreviewVisualComment[]>([]);
  const [stagedReferences, setStagedReferences] = useState<VisualAnnotationReferenceInputBlock[]>(
    []
  );
  const [sentReferences, setSentReferences] = useState<VisualAnnotationReferenceInputBlock[]>([]);
  const [resolvedAnchors, setResolvedAnchors] = useState<
    Record<string, VisualAnnotationResolvedAnchor>
  >({});
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<string[]>([]);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === deviceId) ?? devices[0],
    [deviceId]
  );
  const pendingCount = useMemo(
    () => comments.filter((comment) => comment.status === 'completed').length,
    [comments]
  );
  const stagedCommentIds = useMemo(
    () => stagedReferences.map((reference) => reference.commentId),
    [stagedReferences]
  );

  const setInspectorMode = (enabled: boolean) => {
    inspectorRef.current?.setEnabled(enabled);
    iframeRef.current?.contentWindow?.postMessage(
      { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled },
      '*'
    );
  };

  const attachInspector = () => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow) {
      return;
    }
    inspectorRef.current?.destroy();
    const parentOrigin = window.location.origin;
    inspectorRef.current = createVisualCommentInspector({
      targetWindow: frameWindow,
      allowedParentOrigins: parentOrigin === 'null' ? undefined : [parentOrigin],
      postMessageTargetOrigin: parentOrigin === 'null' ? '*' : parentOrigin,
    });
    setIframeReady(true);
    setInspectorMode(annotationMode);
  };

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      const source = event.source;
      if (source !== iframeRef.current?.contentWindow && source !== window) {
        return;
      }
      const message = event.data;
      if (isVisualAnnotationAnchorsResolvedMessage(message)) {
        startTransition(() => {
          setResolvedAnchors(
            Object.fromEntries(message.payload.results.map((result) => [result.commentId, result]))
          );
        });
        return;
      }
      if (isVisualAnnotationTargetMessage(message)) {
        startTransition(() => {
          setSelectedPayload(message.payload);
        });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      inspectorRef.current?.destroy();
      inspectorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (iframeReady) {
      setInspectorMode(annotationMode);
    }
  }, [annotationMode, iframeReady]);

  useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!iframeReady || !frameWindow) {
      return;
    }
    frameWindow.postMessage(
      {
        type: RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE,
        payload: {
          anchors: comments.map((comment) => ({
            commentId: comment.id,
            anchor: comment.anchor,
          })),
        },
      },
      '*'
    );
  }, [comments, iframeReady]);

  const completeComment = () => {
    const body = draftBody.trim();
    if (!selectedPayload || body.length === 0) {
      return;
    }
    const createdAt = Date.now();
    const comment = createPreviewVisualComment({
      id: `visual-comment-${createdAt}`,
      turnId: storyTurnId,
      body,
      anchor: createMinimalVisualAnnotationAnchor(selectedPayload),
      authorId: storyAuthorId,
      authorName: storyAuthorName,
      createdAt,
    });
    setComments((current) => [comment, ...current]);
    setActiveCommentId(comment.id);
    setCollapsedCommentIds((current) => current.filter((id) => id !== comment.id));
    setSelectedPayload(null);
    setDraftBody('');
  };

  const createReferenceInputBlock = (
    comment: PreviewVisualComment
  ): VisualAnnotationReferenceInputBlock => ({
    type: 'visual_annotation_reference',
    ...createVisualAnnotationReferenceFromPreviewComment(comment),
  });

  const toggleCommentStaged = (comment: PreviewVisualComment) => {
    if (comment.status !== 'completed') {
      return;
    }
    const reference = createReferenceInputBlock(comment);
    setStagedReferences((current) =>
      current.some((item) => item.commentId === comment.id)
        ? current.filter((item) => item.commentId !== comment.id)
        : [reference, ...current]
    );
    setActiveCommentId(comment.id);
  };

  const stagePending = () => {
    const commentsToStage = comments.filter((comment) => comment.status === 'completed');
    if (commentsToStage.length === 0) {
      return;
    }
    setStagedReferences((current) => {
      const existingIds = new Set(current.map((reference) => reference.commentId));
      const nextReferences = commentsToStage
        .filter((comment) => !existingIds.has(comment.id))
        .map(createReferenceInputBlock);
      return nextReferences.length > 0 ? [...nextReferences, ...current] : current;
    });
    setActiveCommentId(commentsToStage[0]?.id ?? null);
  };

  const removeStagedReference = (commentId: string) => {
    setStagedReferences((current) =>
      current.filter((reference) => reference.commentId !== commentId)
    );
  };

  const sendStagedReferences = () => {
    if (stagedReferences.length === 0) {
      return;
    }
    const submittedAt = Date.now();
    const submittedMessageId = `storybook-message-${submittedAt}`;
    const stagedIds = new Set(stagedReferences.map((reference) => reference.commentId));

    setSentReferences((current) => {
      const existingIds = new Set(current.map((reference) => reference.commentId));
      const nextReferences = stagedReferences
        .filter((reference) => !existingIds.has(reference.commentId))
        .map(
          (reference): VisualAnnotationReferenceInputBlock => ({
            ...reference,
            status: 'submitted',
          })
        );
      return nextReferences.length > 0 ? [...nextReferences, ...current] : current;
    });
    setComments((current) =>
      current.map((comment) =>
        stagedIds.has(comment.id)
          ? {
              ...comment,
              status: 'submitted',
              updatedAt: submittedAt,
              submittedAt,
              submittedMessageId,
            }
          : comment
      )
    );
    setStagedReferences([]);
    setActiveCommentId(stagedReferences[0]?.commentId ?? null);
  };

  const resetHarness = () => {
    setAnnotationMode(false);
    setSelectedPayload(null);
    setDraftBody('This element needs a tighter mobile layout.');
    setComments([]);
    setStagedReferences([]);
    setSentReferences([]);
    setResolvedAnchors({});
    setCollapsedCommentIds([]);
    setActiveCommentId(null);
    setInspectorMode(false);
  };

  const scrollPreviewTo = (top: number) => {
    iframeRef.current?.contentWindow?.scrollTo({ top, left: 0, behavior: 'smooth' });
  };

  const toggleCommentCollapsed = (commentId: string) => {
    setCollapsedCommentIds((current) =>
      current.includes(commentId)
        ? current.filter((id) => id !== commentId)
        : [...current, commentId]
    );
    setActiveCommentId((current) => (current === commentId ? null : current));
  };

  const toggleCommentResolved = (input: { commentId: string; resolved: boolean }) => {
    const updatedAt = Date.now();
    setComments((current) =>
      current.map((comment) => {
        if (comment.id !== input.commentId) {
          return comment;
        }
        const next: PreviewVisualComment = { ...comment, updatedAt };
        if (input.resolved) {
          next.resolvedAt = updatedAt;
          next.resolvedBy = storyAuthorId;
        } else {
          delete next.resolvedAt;
          delete next.resolvedBy;
        }
        return next;
      })
    );
    setActiveCommentId(input.resolved ? null : input.commentId);
  };

  return (
    <div {...stylex.props(storyStyles.harness)}>
      <div {...stylex.props(storyStyles.workspace)}>
        <section {...stylex.props(storyStyles.previewPanel)}>
          <div {...stylex.props(storyStyles.previewToolbar)}>
            <div>
              <p {...stylex.props(storyStyles.eyebrow)}>
                Iframe harness
              </p>
              <h2 {...stylex.props(storyStyles.panelTitle)}>
                Live annotation preview
              </h2>
            </div>
            <div {...stylex.props(storyStyles.deviceSwitcher)}>
              {devices.map((device) => (
                <button
                  key={device.id}
                  type="button"
                  {...stylex.props(storyStyles.deviceButton, deviceId === device.id ? storyStyles.selectedDevice : storyStyles.idleDevice)}
                  onClick={() => {
                    setDeviceId(device.id);
                    setIframeReady(false);
                    setSelectedPayload(null);
                    setResolvedAnchors({});
                  }}
                >
                  {device.label}
                </button>
              ))}
            </div>
          </div>

          <div {...stylex.props(storyStyles.previewWell)}>
            <div
              {...stylex.props(storyStyles.previewViewport)}
              style={{
                width: selectedDevice.width,
                height: selectedDevice.height,
              }}
            >
              {/* eslint-disable-next-line react/iframe-missing-sandbox -- Storybook fixture is static srcDoc; sandbox blocks the parent-owned targetWindow harness. */}
              <iframe
                key={deviceId}
                ref={iframeRef}
                title="Visual annotation preview fixture"
                srcDoc={previewSrcDoc}
                onLoad={attachInspector}
                {...stylex.props(storyStyles.previewFrame)}
              />
              <VisualAnnotationCommentsOverlay
                comments={comments}
                viewport={selectedDevice}
                collapsedCommentIds={collapsedCommentIds}
                activeCommentId={activeCommentId}
                onSelectComment={setActiveCommentId}
                onToggleCollapsed={toggleCommentCollapsed}
                onToggleResolved={toggleCommentResolved}
                onSendToChat={toggleCommentStaged}
                stagedCommentIds={stagedCommentIds}
                resolvedAnchors={resolvedAnchors}
              />
            </div>
          </div>
        </section>

        <aside {...stylex.props(storyStyles.controlsPanel)}>
          <div {...stylex.props(storyStyles.controlsHeading)}>
            <div>
              <p {...stylex.props(storyStyles.eyebrow)}>
                Parent controls
              </p>
              <h2 {...stylex.props(storyStyles.panelTitle)}>Annotation mode</h2>
            </div>
            <Button
              type="button"
              variant={annotationMode ? 'primary' : 'secondary'}
              size="small"
              onClick={() => {
                const next = !annotationMode;
                setAnnotationMode(next);
                setInspectorMode(next);
              }}
            >
              <MousePointer2 {...stylex.props(storyStyles.glyph)} />
              {annotationMode ? 'On' : 'Off'}
            </Button>
          </div>

          <div {...stylex.props(storyStyles.twoColumns)}>
            <Button
              type="button"
              variant="secondary"
              size="small"
              onClick={() => scrollPreviewTo(0)}
            >
              Scroll top
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="small"
              onClick={() => scrollPreviewTo(760)}
            >
              Below fold
            </Button>
          </div>

          <div {...stylex.props(storyStyles.metadataPanel)}>
            <div {...stylex.props(storyStyles.metadataGrid)}>
              <span {...stylex.props(storyStyles.mutedText)}>Doc</span>
              <span {...stylex.props(storyStyles.documentId)}>{storyRoomId}</span>
              <span {...stylex.props(storyStyles.mutedText)}>Turn</span>
              <span {...stylex.props(storyStyles.documentId)}>{storyTurnId}</span>
            </div>
          </div>

          <div {...stylex.props(storyStyles.inspectorPanel)}>
            <div {...stylex.props(storyStyles.sectionHeading)}>
              <h3 {...stylex.props(storyStyles.sectionTitle)}>Selected target</h3>
              <span {...stylex.props(storyStyles.targetBadge)}>
                {selectedPayload ? selectedPayload.target.tag : 'none'}
              </span>
            </div>
            {selectedPayload ? (
              <div {...stylex.props(storyStyles.targetEditor)}>
                <p {...stylex.props(storyStyles.targetSelector)}>
                  {selectedPayload.target.selector}
                </p>
                <Textarea
                  value={draftBody}
                  onChange={(event) => setDraftBody(event.target.value)}
                  placeholder="Write a comment for this selected target..."
                  xstyle={storyStyles.commentInput}
                />
                <Button type="button" size="small" width="100%" onClick={completeComment}>
                  <Check {...stylex.props(storyStyles.glyph)} />
                  Add comment
                </Button>
              </div>
            ) : (
              <p {...stylex.props(storyStyles.instructions)}>
                Turn annotation on, hover the iframe, then click an element. The click is captured
                inside the iframe and posted back here.
              </p>
            )}
          </div>

          <div {...stylex.props(storyStyles.inspectorPanel)}>
            <div {...stylex.props(storyStyles.sectionHeading)}>
              <h3 {...stylex.props(storyStyles.sectionTitle)}>Comments</h3>
              <span {...stylex.props(storyStyles.pendingBadge)}>
                {pendingCount} completed
              </span>
            </div>
            <div {...stylex.props(storyStyles.commentsList)}>
              {comments.length > 0 ? (
                comments.map((comment) => {
                  const isResolved = comment.resolvedAt !== undefined;
                  const isSubmitted = comment.status === 'submitted';
                  const isStaged = stagedCommentIds.includes(comment.id);
                  return (
                    <button
                      key={comment.id}
                      type="button"
                      onClick={() => setActiveCommentId(comment.id)}
                      {...stylex.props(storyStyles.commentRow, activeCommentId === comment.id ? storyStyles.selectedComment : storyStyles.idleComment)}
                    >
                      <span
                        {...stylex.props(storyStyles.statusDot, isSubmitted ? storyStyles.submittedDot : isStaged ? storyStyles.stagedDot : isResolved ? storyStyles.resolvedDot : storyStyles.pendingDot)}
                      />
                      <span {...stylex.props(storyStyles.commentText)}>
                        <span {...stylex.props(storyStyles.commentBody)}>
                          {comment.body}
                        </span>
                        <span {...stylex.props(storyStyles.commentTarget)}>
                          {comment.anchor.target.tag}
                          {isSubmitted ? ' · submitted' : isStaged ? ' · staged' : ''}
                          {isResolved ? ' · resolved' : ''}
                        </span>
                      </span>
                    </button>
                  );
                })
              ) : (
                <p {...stylex.props(storyStyles.emptyComments)}>
                  Comments stay here until you reset the harness, simulating the preview Loro doc
                  state.
                </p>
              )}
            </div>
            <div {...stylex.props(storyStyles.commentActions)}>
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={pendingCount === 0}
                onClick={stagePending}
              >
                <SendHorizontal {...stylex.props(storyStyles.glyph)} />
                Stage all
              </Button>
              <Button type="button" variant="secondary" size="small" onClick={resetHarness}>
                {comments.length > 0 || selectedPayload ? (
                  <Trash2 {...stylex.props(storyStyles.glyph)} />
                ) : (
                  <RefreshCw {...stylex.props(storyStyles.glyph)} />
                )}
                Reset
              </Button>
            </div>
          </div>

          <div {...stylex.props(storyStyles.inspectorPanel)}>
            <div {...stylex.props(storyStyles.sectionHeading)}>
              <h3 {...stylex.props(storyStyles.sectionTitle)}>Composer draft</h3>
              <span {...stylex.props(storyStyles.stagedBadge)}>
                {stagedReferences.length} staged
              </span>
            </div>
            {stagedReferences.length > 0 ? (
              <div {...stylex.props(storyStyles.draftStack)}>
                <div {...stylex.props(storyStyles.referenceList)}>
                  {stagedReferences.map((reference) => (
                    <div
                      key={reference.commentId}
                      {...stylex.props(storyStyles.referenceRow)}
                    >
                      <VisualAnnotationReferenceCard
                        reference={reference}
                        xstyle={storyStyles.referenceCard}
                        onClick={() => setActiveCommentId(reference.commentId)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        icon
                        onClick={() => removeStagedReference(reference.commentId)}
                      >
                        <X {...stylex.props(storyStyles.glyph)} />
                      </Button>
                    </div>
                  ))}
                </div>
                <div {...stylex.props(storyStyles.twoColumns)}>
                  <Button type="button" size="small" onClick={sendStagedReferences}>
                    <SendHorizontal {...stylex.props(storyStyles.glyph)} />
                    Send
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    onClick={() => setStagedReferences([])}
                  >
                    Clear
                  </Button>
                </div>
              </div>
            ) : (
              <p {...stylex.props(storyStyles.instructions)}>
                Paper-plane actions add visual annotation references here first. The final send
                button moves staged references into conversation history.
              </p>
            )}
          </div>

          <div {...stylex.props(storyStyles.inspectorPanel)}>
            <div {...stylex.props(storyStyles.sectionHeading)}>
              <h3 {...stylex.props(storyStyles.sectionTitle)}>Conversation</h3>
              <span {...stylex.props(storyStyles.sentBadge)}>
                {sentReferences.length} sent
              </span>
            </div>
            {sentReferences.length > 0 ? (
              <div {...stylex.props(storyStyles.referenceList)}>
                {sentReferences.map((reference) => (
                  <div
                    key={reference.commentId}
                    {...stylex.props(storyStyles.sentReference)}
                  >
                    <p {...stylex.props(storyStyles.referenceLabel)}>
                      Session input block
                    </p>
                    <VisualAnnotationReferenceCard reference={reference} xstyle={storyStyles.referenceCard} />
                  </div>
                ))}
              </div>
            ) : (
              <p {...stylex.props(storyStyles.instructions)}>
                Sent visual annotation references appear here after the composer draft is submitted.
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

const meta = {
  title: 'Preview/VisualAnnotationInspector',
  component: VisualAnnotationInspectorHarness,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof VisualAnnotationInspectorHarness>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LocalHarness: Story = {};
