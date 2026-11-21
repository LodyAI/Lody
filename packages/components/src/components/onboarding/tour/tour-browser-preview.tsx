import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';

import type { PreviewVisualComment } from '@lody/shared/preview-comment-types';
import { VisualAnnotationCommentsOverlay } from '@/components/preview/visual-annotation-comments-overlay';
import { VisualAnnotationDraftComposer } from '@/components/preview/visual-annotation-draft-composer';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { TOUR_ANNOTATION_ANCHOR } from './tour-fixtures';
import { browserPreviewSurface } from './browser-preview-surface';

// The page is necessarily a fixture: onboarding has no dev server for the real
// Managed Preview iframe to load. The annotation UI around it is production UI,
// driven by scripted data just like the rest of the tour.

const COMMENT_ID = 'onboarding-tour-comment';
const TARGET_LABEL = 'div "Nothing here yet"';
const EMPTY_VIEWPORT = { width: 0, height: 0 };
const ignore = () => undefined;

export function TourBrowserPreview({
  /**
   * The beat's progress, 0 -> 1, in four readable stages:
   *
   *   0.00-0.15  nothing yet
   *   0.15-0.35  the element has been clicked; the composer opens on it
   *   0.35-0.80  the comment types itself
   *   0.80-1.00  the comment is staged in chat and shown on the page
   */
  annotation,
  commentBody,
}: {
  annotation: number;
  commentBody: string;
}): React.JSX.Element {
  const previewRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(EMPTY_VIEWPORT);
  const clicked = annotation > 0.15;
  const submitted = annotation >= 0.8;
  const typed = commentBody.slice(
    0,
    Math.round(commentBody.length * clamp01((annotation - 0.35) / 0.45))
  );
  const stagedComment = useMemo<PreviewVisualComment>(
    () => ({
      id: COMMENT_ID,
      turnId: 'onboarding-tour-turn',
      status: 'completed',
      body: commentBody,
      anchor: TOUR_ANNOTATION_ANCHOR,
      authorId: 'onboarding-tour-user',
      authorName: 'You',
      createdAt: 1,
      updatedAt: 1,
    }),
    [commentBody]
  );

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return undefined;

    const updateViewport = () => {
      const rect = preview.getBoundingClientRect();
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      setViewport((current) =>
        current.width === next.width && current.height === next.height ? current : next
      );
    };

    updateViewport();
    return observeResizeOnAnimationFrame(preview, updateViewport);
  }, []);

  return (
    <div data-tour-anchor="browser" {...stylex.props(browserPreviewSurface.page)}>
      <div {...stylex.props(browserPreviewSurface.bar)}>
        <span {...stylex.props(browserPreviewSurface.barDot)} />
        <span {...stylex.props(browserPreviewSurface.address)}>localhost:5173/settings</span>
      </div>

      <div ref={previewRef} {...stylex.props(browserPreviewSurface.body)}>
        <div {...stylex.props(browserPreviewSurface.rows)}>
          <div {...stylex.props(browserPreviewSurface.headingLine)} />
          <div {...stylex.props(browserPreviewSurface.subheadingLine)} />
          <div {...stylex.props(browserPreviewSurface.card)}>
            <div {...stylex.props(browserPreviewSurface.cardLineHead)} />
            <div {...stylex.props(browserPreviewSurface.cardLineFull)} />
            <div {...stylex.props(browserPreviewSurface.cardLineTwoThirds)} />
          </div>

          <div
            data-tour-anchor="browser.target"
            {...stylex.props(
              browserPreviewSurface.target,
              clicked ? browserPreviewSurface.targetActive : browserPreviewSurface.targetIdle
            )}
          >
            <span {...stylex.props(browserPreviewSurface.targetLabel)}>Nothing here yet</span>
          </div>
        </div>

        {clicked && !submitted ? (
          <VisualAnnotationDraftComposer
            targetLabel={TARGET_LABEL}
            value={typed}
            onChange={ignore}
            onCancel={ignore}
            onSubmit={ignore}
            className={stylex.props(browserPreviewSurface.composer).className}
          />
        ) : null}
        {submitted ? (
          <VisualAnnotationCommentsOverlay
            comments={[stagedComment]}
            viewport={viewport}
            activeCommentId={COMMENT_ID}
            stagedCommentIds={[COMMENT_ID]}
            onSendToChat={ignore}
          />
        ) : null}
      </div>
    </div>
  );
}

function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}
