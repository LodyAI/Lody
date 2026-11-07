import { useLayoutEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { RefreshCw, SendHorizontal } from 'lucide-react';

import type { MinimalVisualAnnotationAnchor } from '@lody/shared/visual-annotation-types';
import {
  createPreviewVisualComment,
  type PreviewVisualComment,
} from '@lody/shared/preview-comment-types';
import { VisualAnnotationCommentsOverlay } from '@/components/preview/visual-annotation-comments-overlay';
import { Button } from '@lody/ui/button';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';
import { withClassName } from '../lib/stylex';
const storyLayoutStyles = stylex.create({
  frame: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
});

const storyLayout = stylex.create({
  frame: {
    'min-height': '820px',
    'background-color': 'var(--color-slate-100)',
    padding: 'calc(var(--spacing) * 6)',
    color: 'var(--color-slate-900)',
  },
  row: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  row2: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1)',
    'border-radius': 'var(--radius-lg)',
    'background-color': 'var(--color-slate-100)',
    padding: 'calc(var(--spacing) * 0.5)',
  },
  overlay: {
    position: 'absolute',
    inset: 'calc(var(--spacing) * 0)',
    display: 'grid',
    'grid-template-rows': 'auto 1fr auto',
    gap: 'calc(var(--spacing) * 6)',
    padding: 'calc(var(--spacing) * 10)',
  },
});

const canvasStyles = stylex.create({
  container: { marginInline: 'auto', maxWidth: 1180 },
  header: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[3],
    borderRadius: '1rem',
    backgroundColor: 'white',
    padding: themeSpace[4],
    marginBottom: themeSpace[4],
    boxShadow: '0 0 0 1px var(--color-slate-200), 0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.18em',
    color: 'var(--color-slate-500)',
  },
  title: {
    marginTop: themeSpace[1],
    fontSize: '1.125rem',
    lineHeight: '1.75rem',
    fontWeight: 600,
    color: 'var(--color-slate-900)',
  },
  summary: {
    marginTop: themeSpace[1],
    fontSize: '0.75rem',
    lineHeight: '1rem',
    color: 'var(--color-slate-500)',
  },
  device: {
    borderRadius: 'var(--radius-md)',
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[1],
    fontSize: '0.75rem',
    lineHeight: '1rem',
    fontWeight: 500,
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    transitionDuration: '150ms',
  },
  selectedDevice: {
    backgroundColor: 'white',
    color: 'var(--color-slate-900)',
    boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  otherDevice: { color: { default: 'var(--color-slate-500)', ':hover': 'var(--color-slate-700)' } },
  viewport: {
    overflow: 'auto',
    borderRadius: '1rem',
    backgroundColor: 'color-mix(in oklab, var(--color-slate-200) 60%, transparent)',
    padding: themeSpace[4],
    boxShadow: '0 0 0 1px var(--color-slate-200)',
  },
  preview: {
    position: 'relative',
    marginInline: 'auto',
    overflow: 'hidden',
    borderRadius: '0.75rem',
    backgroundColor: 'white',
    boxShadow:
      '0 0 0 1px var(--color-slate-200), 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  },
  fixtureEyebrow: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.22em',
    color: 'var(--color-slate-400)',
  },
  fixtureGrid: {
    display: 'grid',
    alignItems: 'start',
    gap: themeSpace[8],
    gridTemplateColumns: {
      default: null,
      '@media (min-width: 768px)': 'minmax(0,1.1fr) minmax(220px,0.9fr)',
    },
  },
  headline: {
    fontFamily: 'var(--font-serif)',
    fontSize: 'clamp(36px,7vw,72px)',
    lineHeight: 0.95,
    letterSpacing: '-0.04em',
    color: 'var(--color-slate-900)',
  },
  explanation: {
    marginTop: themeSpace[5],
    maxWidth: 520,
    fontSize: '1rem',
    lineHeight: 'calc(var(--spacing) * 7)',
    color: 'var(--color-slate-600)',
  },
  cta: {
    marginTop: 'calc(var(--spacing) * 7)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: { default: 'var(--color-slate-900)', ':hover': 'var(--color-slate-800)' },
    paddingInline: themeSpace[5],
    paddingBlock: themeSpace[2.5],
    fontSize: '0.875rem',
    lineHeight: '1.25rem',
    fontWeight: 600,
    color: 'white',
    boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    transitionDuration: '150ms',
  },
  confidence: {
    borderRadius: '1rem',
    backgroundColor: 'var(--color-slate-900)',
    padding: themeSpace[6],
    color: 'white',
    boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  },
  confidenceLabel: {
    fontSize: '0.75rem',
    lineHeight: '1rem',
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '0.16em',
    color: 'var(--color-slate-400)',
  },
  confidenceValue: {
    marginTop: themeSpace[1],
    display: 'block',
    fontSize: '3rem',
    lineHeight: 1,
    fontWeight: 600,
    letterSpacing: '-0.04em',
  },
  confidenceDescription: {
    marginTop: themeSpace[6],
    fontSize: '0.875rem',
    lineHeight: 'calc(var(--spacing) * 6)',
    color: 'var(--color-slate-300)',
  },
  footnote: { fontSize: '0.75rem', lineHeight: '1rem', color: 'var(--color-slate-400)' },
});

const overlayDevices = [
  { id: 'desktop', label: 'Desktop', width: 960, height: 620 },
  { id: 'mobile', label: 'Mobile', width: 390, height: 720 },
] as const;

type OverlayDeviceId = (typeof overlayDevices)[number]['id'];

const createAnchor = (input: {
  selector: string;
  tag: string;
  text: string;
  rectRatio: { x: number; y: number; width: number; height: number };
}): MinimalVisualAnnotationAnchor => ({
  version: 1,
  page: {
    url: '/preview',
    pathname: '/preview',
    viewport: {
      width: 960,
      height: 620,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 2,
    },
  },
  click: {
    clientX: input.rectRatio.x * 960,
    clientY: input.rectRatio.y * 620,
    pageX: input.rectRatio.x * 960,
    pageY: input.rectRatio.y * 620,
    viewportXRatio: input.rectRatio.x,
    viewportYRatio: input.rectRatio.y,
  },
  target: {
    tag: input.tag,
    attributes: {},
    text: input.text,
    rect: {
      x: input.rectRatio.x * 960,
      y: input.rectRatio.y * 620,
      width: input.rectRatio.width * 960,
      height: input.rectRatio.height * 620,
    },
    rectRatio: input.rectRatio,
    selector: input.selector,
  },
  context: {
    ancestors: [{ tag: 'main', selector: 'main.preview-shell' }],
    nearbyText: [input.text],
  },
});

const createStoryComments = (): PreviewVisualComment[] => {
  const createdAt = 1_800_000;
  return [
    {
      ...createPreviewVisualComment({
        id: 'comment-heading',
        turnId: 'turn-storybook-visual-comments',
        body: 'Headline crowds the eyebrow label — add a touch more breathing room.',
        anchor: createAnchor({
          selector: 'h1',
          tag: 'h1',
          text: 'Design reviews should point at pixels.',
          rectRatio: { x: 0.08, y: 0.18, width: 0.58, height: 0.18 },
        }),
        authorId: 'ada',
        authorName: 'Ada Lovelace',
        createdAt,
      }),
      status: 'submitted',
      submittedAt: createdAt + 500,
      submittedMessageId: 'message-heading',
    },
    createPreviewVisualComment({
      id: 'comment-cta',
      turnId: 'turn-storybook-visual-comments',
      body: 'CTA needs to stay dominant after collapse — bump weight or add a leading icon.',
      anchor: createAnchor({
        selector: 'button[data-testid="primary-cta"]',
        tag: 'button',
        text: 'Start review',
        rectRatio: { x: 0.08, y: 0.62, width: 0.18, height: 0.07 },
      }),
      authorId: 'grace',
      authorName: 'Grace Hopper',
      createdAt: createdAt + 1_000,
    }),
    {
      ...createPreviewVisualComment({
        id: 'comment-panel',
        turnId: 'turn-storybook-visual-comments',
        body: 'Sidebar metric is good — confidence number reads at a glance now.',
        anchor: createAnchor({
          selector: 'aside[aria-label="Release health"]',
          tag: 'aside',
          text: 'Review confidence 94%',
          rectRatio: { x: 0.7, y: 0.18, width: 0.24, height: 0.45 },
        }),
        authorId: 'linus',
        authorName: 'Linus Torvalds',
        createdAt: createdAt + 2_000,
      }),
      resolvedAt: createdAt + 3_000,
      resolvedBy: 'ada',
    },
    {
      ...createPreviewVisualComment({
        id: 'comment-footer-typo',
        turnId: 'turn-storybook-visual-comments',
        body: 'Typo in the footer copy — "preivew" should be "preview".',
        anchor: createAnchor({
          selector: 'p.footnote',
          tag: 'p',
          text: 'A preivew of upcoming work.',
          rectRatio: { x: 0.1, y: 0.86, width: 0.42, height: 0.06 },
        }),
        authorId: 'edith',
        authorName: 'Edith Clarke',
        createdAt: createdAt + 4_000,
      }),
      resolvedAt: createdAt + 5_000,
      resolvedBy: 'ada',
    },
  ];
};

function VisualAnnotationCommentsOverlayStory() {
  const [deviceId, setDeviceId] = useState<OverlayDeviceId>('desktop');
  const [comments, setComments] = useState(createStoryComments);
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<string[]>([]);
  const [stagedCommentIds, setStagedCommentIds] = useState<string[]>(['comment-cta']);
  const [activeCommentId, setActiveCommentId] = useState<string | null>('comment-heading');
  const selectedDevice =
    overlayDevices.find((device) => device.id === deviceId) ?? overlayDevices[0];

  const toggleCollapsed = (commentId: string) => {
    setCollapsedCommentIds((current) =>
      current.includes(commentId)
        ? current.filter((id) => id !== commentId)
        : [...current, commentId]
    );
    setActiveCommentId((current) => (current === commentId ? null : current));
  };

  const toggleResolved = (input: { commentId: string; resolved: boolean }) => {
    const updatedAt = Date.now();
    setComments((current) =>
      current.map((comment) => {
        if (comment.id !== input.commentId) {
          return comment;
        }
        const next: PreviewVisualComment = { ...comment, updatedAt };
        if (input.resolved) {
          next.resolvedAt = updatedAt;
          next.resolvedBy = 'storybook-user';
        } else {
          delete next.resolvedAt;
          delete next.resolvedBy;
        }
        return next;
      })
    );
    setActiveCommentId(input.resolved ? null : input.commentId);
  };

  const toggleStagedComment = (comment: PreviewVisualComment) => {
    setStagedCommentIds((current) =>
      current.includes(comment.id)
        ? current.filter((commentId) => commentId !== comment.id)
        : [...current, comment.id]
    );
    setActiveCommentId(comment.id);
  };

  const submitStagedComments = () => {
    if (stagedCommentIds.length === 0) {
      return;
    }
    const submittedAt = Date.now();
    const stagedIds = new Set(stagedCommentIds);
    setComments((current) =>
      current.map((comment) =>
        stagedIds.has(comment.id)
          ? {
              ...comment,
              status: 'submitted',
              updatedAt: submittedAt,
              submittedAt,
              submittedMessageId: `storybook-message-${submittedAt}`,
            }
          : comment
      )
    );
    setStagedCommentIds([]);
  };

  const reset = () => {
    setComments(createStoryComments());
    setCollapsedCommentIds([]);
    setStagedCommentIds(['comment-cta']);
    setActiveCommentId('comment-heading');
  };

  const resolvedCount = comments.filter((c) => c.resolvedAt !== undefined).length;
  const openCount = comments.length - resolvedCount;
  const submittedCount = comments.filter((comment) => comment.status === 'submitted').length;
  const stagedCount = stagedCommentIds.length;

  return (
    <div {...stylex.props(storyLayout.frame)}>
      <div {...stylex.props(canvasStyles.container)}>
        <header {...stylex.props(canvasStyles.header)}>
          <div>
            <p {...stylex.props(canvasStyles.eyebrow)}>Preview comments</p>
            <h1 {...stylex.props(canvasStyles.title)}>
              Anchored threads, collapsed dots, hover peek
            </h1>
            <p {...stylex.props(canvasStyles.summary)}>
              {openCount} open · {resolvedCount} resolved · {stagedCount} staged · {submittedCount}{' '}
              submitted · resolved comments are hidden from the canvas
            </p>
          </div>
          <div {...stylex.props(storyLayout.row)}>
            <div {...stylex.props(storyLayout.row2)}>
              {overlayDevices.map((device) => (
                <button
                  key={device.id}
                  type="button"
                  onClick={() => setDeviceId(device.id)}
                  {...stylex.props(
                    canvasStyles.device,
                    deviceId === device.id ? canvasStyles.selectedDevice : canvasStyles.otherDevice
                  )}
                >
                  {device.label}
                </button>
              ))}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={stagedCommentIds.length === 0}
              onClick={submitStagedComments}
            >
              <SendHorizontal {...stylex.props(storyLayoutStyles.frame)} />
              Submit staged
            </Button>
            <Button type="button" variant="secondary" size="small" onClick={reset}>
              <RefreshCw {...stylex.props(storyLayoutStyles.frame)} />
              Reset
            </Button>
          </div>
        </header>

        <div {...stylex.props(canvasStyles.viewport)}>
          <main
            {...stylex.props(canvasStyles.preview)}
            style={{ width: selectedDevice.width, height: selectedDevice.height }}
          >
            <PreviewFixture />
            <VisualAnnotationCommentsOverlay
              comments={comments}
              viewport={selectedDevice}
              collapsedCommentIds={collapsedCommentIds}
              activeCommentId={activeCommentId}
              onSelectComment={setActiveCommentId}
              onToggleCollapsed={toggleCollapsed}
              onToggleResolved={toggleResolved}
              onSendToChat={toggleStagedComment}
              stagedCommentIds={stagedCommentIds}
            />
          </main>
        </div>
      </div>
    </div>
  );
}

function PreviewFixture() {
  return (
    <div {...stylex.props(storyLayout.overlay)}>
      <p {...stylex.props(canvasStyles.fixtureEyebrow)}>Preview fixture</p>
      <div {...stylex.props(canvasStyles.fixtureGrid)}>
        <div>
          <h2 {...stylex.props(canvasStyles.headline)}>Design reviews should point at pixels.</h2>
          <p {...stylex.props(canvasStyles.explanation)}>
            Floating comments stay anchored to rect ratios so the same comment renders consistently
            across desktop and mobile preview widths.
          </p>
          <button type="button" {...stylex.props(canvasStyles.cta)}>
            Start review
          </button>
        </div>
        <aside {...stylex.props(canvasStyles.confidence)}>
          <p {...stylex.props(canvasStyles.confidenceLabel)}>Review confidence</p>
          <strong {...stylex.props(canvasStyles.confidenceValue)}>94%</strong>
          <p {...stylex.props(canvasStyles.confidenceDescription)}>
            Resolved comments disappear from the canvas so open feedback stays focused.
          </p>
        </aside>
      </div>
      <p {...withClassName(stylex.props(canvasStyles.footnote), 'footnote')}>
        A preivew of upcoming work.
      </p>
    </div>
  );
}

const meta = {
  title: 'Preview/VisualAnnotationCommentsOverlay',
  component: VisualAnnotationCommentsOverlayStory,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof VisualAnnotationCommentsOverlayStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AnchoredThreads: Story = {};

const migrationStyles = stylex.create({
  canvas: { padding: themeSpace[4], backgroundColor: themeColors.background },
  frame: {
    position: 'relative',
    width: '100%',
    maxWidth: 960,
    height: 520,
    backgroundColor: themeColors.background,
    outline: `1px solid ${themeColors.border}`,
  },
  corners: { height: 360 },
  controls: { display: 'flex', gap: themeSpace[2], marginBottom: themeSpace[4] },
  scopes: { display: 'flex', flexWrap: 'wrap', gap: themeSpace[4] },
  scope: { width: 330, maxWidth: '100%' },
  scopeFrame: { height: 190 },
  label: { color: themeColors.foreground, marginBottom: themeSpace[2] },
});

function MigrationOverlayFixture({
  corners = false,
  scope = false,
}: {
  corners?: boolean;
  scope?: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const height = scope ? 190 : corners ? 360 : 520;
  const [width, setWidth] = useState(0);
  const makeComments = (): PreviewVisualComment[] => {
    const positions = corners
      ? [
          { name: 'Top Left', x: 0.08, y: 0.08 },
          { name: 'Top Right', x: 0.9, y: 0.08 },
          { name: 'Bottom Left', x: 0.08, y: 0.9 },
          { name: 'Bottom Right', x: 0.9, y: 0.9 },
        ]
      : scope
        ? [{ name: 'Scoped Reviewer', x: 0.08, y: 0.14 }]
        : [
            { name: 'Ada Lovelace', x: 0.08, y: 0.08 },
            { name: 'Grace Hopper', x: 0.08, y: 0.4 },
            { name: 'Edsger Dijkstra', x: 0.08, y: 0.72 },
          ];
    return positions.map((position, index) => ({
      ...createPreviewVisualComment({
        id: `migration-${index}`,
        turnId: 'synthetic-overlay-migration',
        body: corners
          ? `${position.name}: a deliberately long comment checks the two-line collapsed preview and its original corner placement.`
          : 'Keep the original review marker, card and action feedback.',
        anchor: createAnchor({
          selector: `#synthetic-review-target-${index}`,
          tag: 'div',
          text: position.name,
          rectRatio: { x: position.x, y: position.y, width: 0.02, height: 0.02 },
        }),
        authorId: `synthetic-reviewer-${index}`,
        authorName: position.name,
        createdAt: 1_800_000 + index,
      }),
      ...(!corners && !scope && index === 2
        ? {
            status: 'submitted' as const,
            submittedAt: 1_800_100,
            submittedMessageId: 'synthetic-message',
          }
        : {}),
    }));
  };
  const [comments, setComments] = useState(makeComments);
  const [collapsed, setCollapsed] = useState<string[]>(() =>
    corners ? makeComments().map((comment) => comment.id) : []
  );
  const [active, setActive] = useState<string | null>(corners || scope ? null : 'migration-0');
  const [staged, setStaged] = useState<string[]>(scope ? ['migration-0'] : ['migration-1']);

  useLayoutEffect(() => {
    const node = frame.current;
    if (!node) return undefined;
    const update = () => setWidth(node.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const toggleCollapsed = (id: string) => {
    setCollapsed((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
    setActive((current) => (current === id ? null : current));
  };

  return (
    <>
      {!scope ? (
        <div {...stylex.props(migrationStyles.controls)}>
          <Button
            onClick={() => {
              setComments(makeComments());
              setCollapsed(corners ? makeComments().map((comment) => comment.id) : []);
              setActive(corners ? null : 'migration-0');
              setStaged(['migration-1']);
            }}
          >
            Reset overlay fixture
          </Button>
        </div>
      ) : null}
      <div
        ref={frame}
        data-overlay-migration-frame={corners ? 'corners' : scope ? 'scope' : 'states'}
        {...stylex.props(
          migrationStyles.frame,
          corners && migrationStyles.corners,
          scope && migrationStyles.scopeFrame
        )}
      >
        <VisualAnnotationCommentsOverlay
          comments={comments}
          viewport={{ width, height }}
          activeCommentId={active}
          collapsedCommentIds={collapsed}
          stagedCommentIds={staged}
          onSelectComment={setActive}
          onToggleCollapsed={toggleCollapsed}
          onSendToChat={(comment) => {
            setStaged((current) =>
              current.includes(comment.id)
                ? current.filter((id) => id !== comment.id)
                : [...current, comment.id]
            );
            setActive(comment.id);
          }}
          onToggleResolved={({ commentId }) =>
            setComments((current) =>
              current.map((comment) =>
                comment.id === commentId
                  ? { ...comment, resolvedAt: 1_800_200, resolvedBy: 'synthetic-reviewer' }
                  : comment
              )
            )
          }
        />
      </div>
    </>
  );
}

export const NativeStates: Story = {
  render: () => (
    <div {...stylex.props(migrationStyles.canvas)}>
      <MigrationOverlayFixture />
    </div>
  ),
};

export const CornerPeeks: Story = {
  render: () => (
    <div {...stylex.props(migrationStyles.canvas)}>
      <MigrationOverlayFixture corners />
    </div>
  ),
};

export const ThemeScopes: Story = {
  render: () => (
    <div {...stylex.props(migrationStyles.canvas, migrationStyles.scopes)}>
      <section {...withClassName(stylex.props(migrationStyles.scope), 'dark-scope')}>
        <p {...stylex.props(migrationStyles.label)}>Explicit dark scope</p>
        <MigrationOverlayFixture scope />
      </section>
      <section {...withClassName(stylex.props(migrationStyles.scope), 'dark-scope light-scope')}>
        <p {...stylex.props(migrationStyles.label)}>Light scope inside dark scope</p>
        <MigrationOverlayFixture scope />
      </section>
    </div>
  ),
};
