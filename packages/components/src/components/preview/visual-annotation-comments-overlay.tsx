import type { CSSProperties } from 'react';
import { Check, SendHorizontal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@lody/ui/badge';

import type { PreviewVisualComment } from '@lody/shared/preview-comment-types';
import type { VisualAnnotationResolvedAnchor } from '@lody/shared/visual-annotation-types';
import { cn } from '@/lib/utils';
import { getVisiblePreviewVisualComments } from '@/components/preview/preview-visual-comments';

export type VisualAnnotationOverlayViewport = {
  width: number;
  height: number;
};

export type VisualAnnotationCommentsOverlayProps = {
  comments: readonly PreviewVisualComment[];
  viewport: VisualAnnotationOverlayViewport;
  collapsedCommentIds?: readonly string[];
  activeCommentId?: string | null;
  className?: string;
  onSelectComment?: (commentId: string) => void;
  onToggleCollapsed?: (commentId: string) => void;
  onToggleResolved?: (input: { commentId: string; resolved: boolean }) => void;
  onSendToChat?: (comment: PreviewVisualComment) => void;
  stagedCommentIds?: readonly string[];
  resolvedAnchors?: Readonly<Record<string, VisualAnnotationResolvedAnchor | undefined>>;
};

const VIEWPORT_MARGIN = 12;
const CARD_WIDTH = 264;
const PEEK_WIDTH = 224;
const PEEK_HEIGHT_HINT = 76;
const PIN_TO_CARD_GAP = 14;

const clamp = (value: number, min: number, max: number): number =>
  max < min ? min : Math.min(Math.max(value, min), max);
const round = (value: number): number => Math.round(value * 100) / 100;

type PinPosition = {
  x: number;
  y: number;
};

const getPinPosition = (
  comment: PreviewVisualComment,
  viewport: VisualAnnotationOverlayViewport,
  resolvedAnchor?: VisualAnnotationResolvedAnchor
): PinPosition => {
  const r =
    resolvedAnchor?.resolved === true && resolvedAnchor.rectRatio
      ? resolvedAnchor.rectRatio
      : comment.anchor.target.rectRatio;
  const targetX = r.x * viewport.width;
  const targetY = r.y * viewport.height;
  const targetW = r.width * viewport.width;
  const targetH = r.height * viewport.height;
  return {
    x: round(clamp(targetX + targetW / 2, VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN)),
    y: round(clamp(targetY + targetH / 2, VIEWPORT_MARGIN, viewport.height - VIEWPORT_MARGIN)),
  };
};

type CardLayout = {
  pinX: number;
  pinY: number;
  cardLeft: number;
  cardTop: number;
  cardWidth: number;
};

const getOpenLayout = (
  comment: PreviewVisualComment,
  viewport: VisualAnnotationOverlayViewport,
  index: number,
  resolvedAnchor?: VisualAnnotationResolvedAnchor
): CardLayout => {
  const pin = getPinPosition(comment, viewport, resolvedAnchor);
  const cardWidth = Math.min(CARD_WIDTH, Math.max(200, viewport.width - 32));
  const rightSpace = viewport.width - pin.x;
  const leftSpace = pin.x;
  const placeRight =
    rightSpace >= cardWidth + PIN_TO_CARD_GAP + VIEWPORT_MARGIN || rightSpace >= leftSpace;
  const cardLeftRaw = placeRight ? pin.x + PIN_TO_CARD_GAP : pin.x - cardWidth - PIN_TO_CARD_GAP;
  const cardLeft = clamp(
    cardLeftRaw,
    VIEWPORT_MARGIN,
    viewport.width - cardWidth - VIEWPORT_MARGIN
  );
  const cardTop = clamp(
    pin.y - 18 + index * 4,
    VIEWPORT_MARGIN,
    viewport.height - 96 - VIEWPORT_MARGIN
  );
  return {
    pinX: pin.x,
    pinY: pin.y,
    cardLeft: round(cardLeft),
    cardTop: round(cardTop),
    cardWidth: round(cardWidth),
  };
};

const getInitials = (comment: PreviewVisualComment): string => {
  const source = comment.authorName ?? comment.authorId;
  const initials = source
    .split(/\s+/g)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('');
  return initials.length > 0 ? initials.toUpperCase() : 'U';
};

// Hash author id/name into a stable HSL hue. Avatars get a personal accent
// color while pins keep the shared review marker color, so identity and anchor
// state stay visually distinct.
const getAuthorHue = (comment: PreviewVisualComment): number => {
  const source = comment.authorName ?? comment.authorId;
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
};

const getAuthorAvatarStyle = (comment: PreviewVisualComment): CSSProperties => {
  const hue = getAuthorHue(comment);
  return { backgroundColor: `hsl(${hue} 58% 42%)` };
};

const isResolvedAnchorVisible = (
  resolvedAnchor: VisualAnnotationResolvedAnchor | undefined,
  viewport: VisualAnnotationOverlayViewport
): boolean => {
  if (!resolvedAnchor) {
    return true;
  }
  if (!resolvedAnchor.resolved) {
    return false;
  }
  const rect = resolvedAnchor.rect;
  if (!rect) {
    return true;
  }
  return (
    rect.right > 0 && rect.bottom > 0 && rect.left < viewport.width && rect.top < viewport.height
  );
};

export function VisualAnnotationCommentsOverlay({
  comments,
  viewport,
  collapsedCommentIds = [],
  activeCommentId,
  className,
  onSelectComment,
  onToggleCollapsed,
  onToggleResolved,
  onSendToChat,
  stagedCommentIds = [],
  resolvedAnchors,
}: VisualAnnotationCommentsOverlayProps) {
  const visibleComments = getVisiblePreviewVisualComments(comments);

  if (visibleComments.length === 0 || viewport.width <= 0 || viewport.height <= 0) {
    return null;
  }

  return (
    <div
      data-lody-visual-comment-overlay="true"
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
      style={{ width: viewport.width, height: viewport.height }}
    >
      {visibleComments.map((comment, index) => {
        const isSubmitted = comment.status === 'submitted';
        const isStaged = stagedCommentIds.includes(comment.id);
        const resolvedAnchor = resolvedAnchors?.[comment.id];
        if (!isResolvedAnchorVisible(resolvedAnchor, viewport)) {
          return null;
        }
        const isUserCollapsed = collapsedCommentIds.includes(comment.id);
        const isActive = activeCommentId === comment.id;
        if (isUserCollapsed) {
          return (
            <CollapsedComment
              key={comment.id}
              comment={comment}
              viewport={viewport}
              resolvedAnchor={resolvedAnchor}
              onOpen={() => {
                onSelectComment?.(comment.id);
                onToggleCollapsed?.(comment.id);
              }}
            />
          );
        }
        return (
          <OpenComment
            key={comment.id}
            comment={comment}
            viewport={viewport}
            index={index}
            resolvedAnchor={resolvedAnchor}
            isActive={isActive}
            onSelect={onSelectComment}
            onCollapse={onToggleCollapsed}
            onToggleResolved={onToggleResolved}
            onSendToChat={onSendToChat}
            isSubmitted={isSubmitted}
            isStaged={isStaged}
          />
        );
      })}
    </div>
  );
}

type OpenCommentProps = {
  comment: PreviewVisualComment;
  viewport: VisualAnnotationOverlayViewport;
  index: number;
  resolvedAnchor?: VisualAnnotationResolvedAnchor;
  isActive: boolean;
  isSubmitted: boolean;
  isStaged: boolean;
  onSelect?: (commentId: string) => void;
  onCollapse?: (commentId: string) => void;
  onToggleResolved?: (input: { commentId: string; resolved: boolean }) => void;
  onSendToChat?: (comment: PreviewVisualComment) => void;
};

function OpenComment({
  comment,
  viewport,
  index,
  resolvedAnchor,
  isActive,
  isSubmitted,
  isStaged,
  onSelect,
  onCollapse,
  onToggleResolved,
  onSendToChat,
}: OpenCommentProps) {
  const { t } = useTranslation();
  const layout = getOpenLayout(comment, viewport, index, resolvedAnchor);
  const isDraft = comment.status === 'completed';

  return (
    <>
      <button
        type="button"
        aria-label={`Visual comment by ${comment.authorName ?? 'reviewer'}`}
        className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer p-1.5 outline-hidden"
        style={{ left: layout.pinX, top: layout.pinY, zIndex: isActive ? 80 : 40 + index }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect?.(comment.id);
        }}
      >
        <span
          className={cn(
            'block h-3 w-3 rounded-full bg-amber-500 ring-2 ring-background transition-transform duration-150 ease-out',
            isActive ? 'scale-125' : 'hover:scale-110'
          )}
        />
      </button>
      <article
        data-visual-comment-id={comment.id}
        className={cn(
          'pointer-events-auto absolute overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-[0_10px_30px_rgba(15,23,42,0.12)] ring-1 transition-shadow duration-150',
          isActive
            ? 'shadow-[0_18px_45px_rgba(15,23,42,0.18)] ring-ring/50'
            : 'ring-border hover:shadow-[0_14px_36px_rgba(15,23,42,0.14)]'
        )}
        style={{
          left: layout.cardLeft,
          top: layout.cardTop,
          width: layout.cardWidth,
          zIndex: isActive ? 81 : 41 + index,
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect?.(comment.id);
        }}
      >
        <div className="flex items-start gap-2.5 px-3 pt-3">
          <span
            aria-hidden
            className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tracking-wide text-white"
            style={getAuthorAvatarStyle(comment)}
          >
            {getInitials(comment)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-xs font-semibold leading-4 text-popover-foreground">
              <span className="truncate">{comment.authorName ?? 'Reviewer'}</span>
              {isDraft ? (
                <Badge tone="warning">
                  {t('sessions.preview.annotation.statusDraft', 'Draft')}
                </Badge>
              ) : null}
              {isSubmitted ? (
                <Badge>{t('sessions.preview.annotation.statusSent', 'Sent')}</Badge>
              ) : null}
            </p>
            <p className="mt-1 whitespace-pre-line break-words text-[13px] leading-5 text-popover-foreground/80">
              {comment.body}
            </p>
          </div>
          {onCollapse ? (
            <button
              type="button"
              aria-label="Collapse comment"
              className="-mr-1 -mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-popover-foreground"
              onClick={(event) => {
                event.stopPropagation();
                onCollapse(comment.id);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        {onToggleResolved || onSendToChat ? (
          <div className="mt-2 flex items-center justify-between gap-1 border-t border-border px-1.5 py-1">
            {onSendToChat ? (
              <button
                type="button"
                aria-pressed={isSubmitted || isStaged}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                  isSubmitted
                    ? 'cursor-default text-muted-foreground'
                    : isStaged
                      ? 'text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-500/10'
                      : 'text-muted-foreground hover:bg-hover hover:text-popover-foreground'
                )}
                disabled={isSubmitted}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!isSubmitted) {
                    onSendToChat(comment);
                  }
                }}
              >
                {isSubmitted || isStaged ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <SendHorizontal className="h-3 w-3 -scale-x-100" />
                )}
                {isSubmitted ? 'Sent' : isStaged ? 'Added' : 'Send'}
              </button>
            ) : (
              <span />
            )}
            {onToggleResolved ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleResolved({ commentId: comment.id, resolved: true });
                }}
              >
                <Check className="h-3 w-3" />
                Resolve
              </button>
            ) : (
              <span />
            )}
          </div>
        ) : null}
      </article>
    </>
  );
}

type CollapsedCommentProps = {
  comment: PreviewVisualComment;
  viewport: VisualAnnotationOverlayViewport;
  resolvedAnchor?: VisualAnnotationResolvedAnchor;
  onOpen: () => void;
};

function CollapsedComment({ comment, viewport, resolvedAnchor, onOpen }: CollapsedCommentProps) {
  const pin = getPinPosition(comment, viewport, resolvedAnchor);
  // Decide which corner the peek expands from so it stays inside the viewport.
  // We anchor the transform-origin to the corner closest to the dot, which
  // makes the open animation feel like it grows out of the dot itself.
  const placeRight = viewport.width - pin.x >= PEEK_WIDTH + PIN_TO_CARD_GAP * 2;
  const placeBelow = viewport.height - pin.y >= PEEK_HEIGHT_HINT + PIN_TO_CARD_GAP * 2;
  const peekStyle: CSSProperties = {
    width: PEEK_WIDTH,
    [placeRight ? 'left' : 'right']: 10,
    [placeBelow ? 'top' : 'bottom']: 10,
  };
  const originClass = placeBelow
    ? placeRight
      ? 'origin-top-left'
      : 'origin-top-right'
    : placeRight
      ? 'origin-bottom-left'
      : 'origin-bottom-right';

  return (
    <div
      // Lift the wrapper above sibling open cards on hover/focus so the peek
      // never gets clipped by another comment that happens to sit nearby.
      className="pointer-events-none group/dot absolute z-[30] hover:z-[90] focus-within:z-[90]"
      style={{ left: pin.x, top: pin.y }}
    >
      <button
        type="button"
        aria-label={`Collapsed comment by ${comment.authorName ?? 'reviewer'}`}
        className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer p-2 outline-hidden"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        <span
          className={cn(
            'block h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-background transition-transform duration-150 ease-out',
            'group-hover/dot:scale-[1.6] group-focus-within/dot:scale-[1.6]'
          )}
        />
      </button>
      <div
        className={cn(
          'pointer-events-none absolute scale-90 opacity-0 transition-all duration-150 ease-out',
          originClass,
          'group-hover/dot:pointer-events-auto group-hover/dot:scale-100 group-hover/dot:opacity-100',
          'group-focus-within/dot:pointer-events-auto group-focus-within/dot:scale-100 group-focus-within/dot:opacity-100'
        )}
        style={peekStyle}
      >
        <button
          type="button"
          className="block w-full overflow-hidden rounded-lg bg-popover text-left text-popover-foreground shadow-[0_12px_30px_rgba(15,23,42,0.18)] ring-1 ring-border outline-hidden transition-shadow hover:shadow-[0_18px_40px_rgba(15,23,42,0.22)] focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          <div className="flex items-start gap-2 px-2.5 py-2">
            <span
              aria-hidden
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold tracking-wide text-white"
              style={getAuthorAvatarStyle(comment)}
            >
              {getInitials(comment)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold leading-4 text-popover-foreground">
                <span className="truncate">{comment.authorName ?? 'Reviewer'}</span>
              </p>
              <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-popover-foreground/75">
                {comment.body}
              </p>
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}
