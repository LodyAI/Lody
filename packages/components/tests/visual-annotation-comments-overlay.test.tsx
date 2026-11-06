// @vitest-environment jsdom

import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createPreviewVisualComment } from '@lody/shared/preview-comment-types';
import type { MinimalVisualAnnotationAnchor } from '@lody/shared/visual-annotation-types';
import { VisualAnnotationCommentsOverlay } from '../src/components/preview/visual-annotation-comments-overlay';

const anchor: MinimalVisualAnnotationAnchor = {
  version: 1,
  page: {
    url: '/preview',
    pathname: '/preview',
    viewport: { width: 600, height: 400, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
  },
  click: {
    clientX: 120,
    clientY: 180,
    pageX: 120,
    pageY: 180,
    viewportXRatio: 0.2,
    viewportYRatio: 0.45,
  },
  target: {
    tag: 'button',
    attributes: { 'data-testid': 'primary-cta' },
    text: 'Start review',
    rect: { x: 100, y: 160, width: 120, height: 40 },
    rectRatio: { x: 0.17, y: 0.4, width: 0.2, height: 0.1 },
    selector: '[data-testid="primary-cta"]',
  },
  context: { ancestors: [], nearbyText: ['Start review'] },
};

const comment = createPreviewVisualComment({
  id: 'comment-1',
  turnId: 'turn-1',
  body: 'Move this action closer to the copy.',
  anchor,
  authorId: 'user-1',
  authorName: 'Ada',
  createdAt: 1,
});

describe('VisualAnnotationCommentsOverlay', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  const render = (node: ReactNode) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(node));
    return container;
  };

  it('collapses an active comment down to its anchor when the close button is clicked', () => {
    function Harness() {
      const [activeCommentId, setActiveCommentId] = useState<string | null>(comment.id);
      const [collapsedCommentIds, setCollapsedCommentIds] = useState<string[]>([]);

      return (
        <VisualAnnotationCommentsOverlay
          comments={[comment]}
          viewport={{ width: 600, height: 400 }}
          activeCommentId={activeCommentId}
          collapsedCommentIds={collapsedCommentIds}
          onSelectComment={setActiveCommentId}
          onToggleCollapsed={(commentId) =>
            setCollapsedCommentIds((current) =>
              current.includes(commentId)
                ? current.filter((id) => id !== commentId)
                : [...current, commentId]
            )
          }
        />
      );
    }

    const rendered = render(<Harness />);
    expect(rendered.querySelector('[data-visual-comment-id="comment-1"]')).not.toBeNull();

    const closeButton = rendered.querySelector(
      'button[aria-label="Collapse comment"]'
    ) as HTMLButtonElement | null;
    if (!closeButton) {
      throw new Error('Expected close button to be rendered');
    }

    flushSync(() => {
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(rendered.querySelector('[data-visual-comment-id="comment-1"]')).toBeNull();
    expect(rendered.querySelector('button[aria-label="Collapsed comment by Ada"]')).not.toBeNull();
  });

  it('stages a comment through its action and removes it when resolved', () => {
    function Harness() {
      const [staged, setStaged] = useState<string[]>([]);
      const [resolved, setResolved] = useState(false);
      return (
        <VisualAnnotationCommentsOverlay
          comments={resolved ? [{ ...comment, resolvedAt: 2, resolvedBy: 'user-1' }] : [comment]}
          viewport={{ width: 600, height: 400 }}
          stagedCommentIds={staged}
          onSendToChat={(selected) => setStaged([selected.id])}
          onToggleResolved={({ commentId, resolved: next }) => {
            if (commentId === comment.id) setResolved(next);
          }}
        />
      );
    }
    const rendered = render(<Harness />);
    const button = (label: string) => {
      const node = Array.from(rendered.querySelectorAll('button')).find(
        (element) => element.textContent?.trim() === label
      );
      if (!node) throw new Error(`Missing ${label} action`);
      return node;
    };
    flushSync(() => button('Send').click());
    expect(button('Added').getAttribute('aria-pressed')).toBe('true');
    flushSync(() => button('Resolve').click());
    expect(rendered.querySelector('[data-visual-comment-id]')).toBeNull();
  });

  it('hides comments whose resolved target rect is outside the iframe viewport', () => {
    const rendered = render(
      <VisualAnnotationCommentsOverlay
        comments={[comment]}
        viewport={{ width: 600, height: 400 }}
        activeCommentId={comment.id}
        resolvedAnchors={{
          [comment.id]: {
            commentId: comment.id,
            resolved: true,
            rect: {
              x: 100,
              y: 460,
              width: 120,
              height: 40,
              top: 460,
              left: 100,
              right: 220,
              bottom: 500,
            },
            rectRatio: { x: 0.17, y: 1.15, width: 0.2, height: 0.1 },
          },
        }}
      />
    );

    expect(rendered.querySelector('[data-visual-comment-id="comment-1"]')).toBeNull();
    expect(rendered.querySelector('button[aria-label$="comment by Ada"]')).toBeNull();
  });

  it('moves a persisted comment when the iframe reports a new target rect', () => {
    const renderOverlay = (y: number) => (
      <VisualAnnotationCommentsOverlay
        comments={[comment]}
        viewport={{ width: 600, height: 400 }}
        activeCommentId={comment.id}
        resolvedAnchors={{
          [comment.id]: {
            commentId: comment.id,
            resolved: true,
            rect: {
              x: 100,
              y,
              width: 120,
              height: 40,
              top: y,
              left: 100,
              right: 220,
              bottom: y + 40,
            },
            rectRatio: { x: 1 / 6, y: y / 400, width: 0.2, height: 0.1 },
          },
        }}
      />
    );

    const rendered = render(renderOverlay(160));
    let card = rendered.querySelector('[data-visual-comment-id="comment-1"]') as HTMLElement | null;
    expect(card?.style.top).toBe('162px');

    flushSync(() => root?.render(renderOverlay(40)));

    card = rendered.querySelector('[data-visual-comment-id="comment-1"]') as HTMLElement | null;
    expect(card?.style.top).toBe('42px');
  });

  it('hides resolved comments instead of rendering a collapsed anchor', () => {
    const rendered = render(
      <VisualAnnotationCommentsOverlay
        comments={[
          {
            ...comment,
            resolvedAt: 2,
            resolvedBy: 'user-1',
          },
        ]}
        viewport={{ width: 600, height: 400 }}
        activeCommentId={comment.id}
      />
    );

    expect(rendered.querySelector('[data-lody-visual-comment-overlay="true"]')).toBeNull();
    expect(rendered.querySelector('[data-visual-comment-id="comment-1"]')).toBeNull();
    expect(rendered.querySelector('button[aria-label="Visual comment by Ada"]')).toBeNull();
    expect(rendered.querySelector('button[aria-label="Collapsed comment by Ada"]')).toBeNull();
  });

  it('hides comments while their anchor cannot be resolved in the iframe', () => {
    const rendered = render(
      <VisualAnnotationCommentsOverlay
        comments={[comment]}
        viewport={{ width: 600, height: 400 }}
        activeCommentId={comment.id}
        resolvedAnchors={{
          [comment.id]: {
            commentId: comment.id,
            resolved: false,
          },
        }}
      />
    );

    expect(rendered.querySelector('[data-visual-comment-id="comment-1"]')).toBeNull();
    expect(rendered.querySelector('button[aria-label$="comment by Ada"]')).toBeNull();
  });
});
