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
    <div className="min-h-[820px] bg-slate-100 p-6 text-slate-900">
      <div className="mx-auto max-w-[1180px] space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-xs ring-1 ring-slate-200">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Preview comments
            </p>
            <h1 className="mt-1 text-lg font-semibold text-slate-900">
              Anchored threads, collapsed dots, hover peek
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              {openCount} open · {resolvedCount} resolved · {stagedCount} staged · {submittedCount}{' '}
              submitted · resolved comments are hidden from the canvas
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
              {overlayDevices.map((device) => (
                <button
                  key={device.id}
                  type="button"
                  onClick={() => setDeviceId(device.id)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    deviceId === device.id
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
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
              <SendHorizontal className="h-3.5 w-3.5" />
              Submit staged
            </Button>
            <Button type="button" variant="secondary" size="small" onClick={reset}>
              <RefreshCw className="h-3.5 w-3.5" />
              Reset
            </Button>
          </div>
        </header>

        <div className="overflow-auto rounded-2xl bg-slate-200/60 p-4 ring-1 ring-slate-200">
          <main
            className="relative mx-auto overflow-hidden rounded-xl bg-white shadow-xl ring-1 ring-slate-200"
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
    <div className="absolute inset-0 grid grid-rows-[auto_1fr_auto] gap-6 p-10">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
        Preview fixture
      </p>
      <div className="grid items-start gap-8 md:grid-cols-[minmax(0,1.1fr)_minmax(220px,0.9fr)]">
        <div>
          <h2 className="font-serif text-[clamp(36px,7vw,72px)] leading-[0.95] tracking-[-0.04em] text-slate-900">
            Design reviews should point at pixels.
          </h2>
          <p className="mt-5 max-w-[520px] text-base leading-7 text-slate-600">
            Floating comments stay anchored to rect ratios so the same comment renders consistently
            across desktop and mobile preview widths.
          </p>
          <button
            type="button"
            className="mt-7 inline-flex items-center justify-center rounded-full bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-slate-800"
          >
            Start review
          </button>
        </div>
        <aside className="rounded-2xl bg-slate-900 p-6 text-white shadow-xl">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
            Review confidence
          </p>
          <strong className="mt-1 block text-5xl font-semibold tracking-[-0.04em]">94%</strong>
          <p className="mt-6 text-sm leading-6 text-slate-300">
            Resolved comments disappear from the canvas so open feedback stays focused.
          </p>
        </aside>
      </div>
      <p className="footnote text-xs text-slate-400">A preivew of upcoming work.</p>
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
