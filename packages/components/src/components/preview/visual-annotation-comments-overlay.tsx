import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeDuration,
  themeEasing,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';
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
      className={cn(stylex.props(styles.root).className, className)}
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
        {...stylex.props(styles.pin)}
        style={{ left: layout.pinX, top: layout.pinY, zIndex: isActive ? 80 : 40 + index }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect?.(comment.id);
        }}
      >
        <span {...stylex.props(styles.pinDot, isActive ? styles.activeDot : styles.inactiveDot)} />
      </button>
      <article
        data-visual-comment-id={comment.id}
        {...stylex.props(styles.card, isActive ? styles.activeCard : styles.inactiveCard)}
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
        <div {...stylex.props(styles.header)}>
          <span aria-hidden {...stylex.props(styles.avatar)} style={getAuthorAvatarStyle(comment)}>
            {getInitials(comment)}
          </span>
          <div {...stylex.props(styles.textColumn)}>
            <p {...stylex.props(styles.author)}>
              <span {...stylex.props(styles.truncate)}>{comment.authorName ?? 'Reviewer'}</span>
              {isDraft ? (
                <Badge tone="warning">
                  {t('sessions.preview.annotation.statusDraft', 'Draft')}
                </Badge>
              ) : null}
              {isSubmitted ? (
                <Badge>{t('sessions.preview.annotation.statusSent', 'Sent')}</Badge>
              ) : null}
            </p>
            <p {...stylex.props(styles.body)}>{comment.body}</p>
          </div>
          {onCollapse ? (
            <button
              type="button"
              aria-label="Collapse comment"
              {...stylex.props(styles.collapseButton)}
              onClick={(event) => {
                event.stopPropagation();
                onCollapse(comment.id);
              }}
            >
              <X {...stylex.props(styles.closeIcon)} />
            </button>
          ) : null}
        </div>
        {onToggleResolved || onSendToChat ? (
          <div {...stylex.props(styles.footer)}>
            {onSendToChat ? (
              <button
                type="button"
                aria-pressed={isSubmitted || isStaged}
                {...stylex.props(
                  styles.action,
                  isSubmitted
                    ? styles.sentAction
                    : isStaged
                      ? styles.positiveAction
                      : styles.sendAction
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
                  <Check {...stylex.props(styles.actionIcon)} />
                ) : (
                  <SendHorizontal {...stylex.props(styles.sendIcon)} />
                )}
                {isSubmitted ? 'Sent' : isStaged ? 'Added' : 'Send'}
              </button>
            ) : (
              <span />
            )}
            {onToggleResolved ? (
              <button
                type="button"
                {...stylex.props(styles.action, styles.positiveAction)}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleResolved({ commentId: comment.id, resolved: true });
                }}
              >
                <Check {...stylex.props(styles.actionIcon)} />
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
  const originStyle = placeBelow
    ? placeRight
      ? styles.peekTopLeft
      : styles.peekTopRight
    : placeRight
      ? styles.peekBottomLeft
      : styles.peekBottomRight;

  return (
    <div
      // Lift the wrapper above sibling open cards on hover/focus so the peek
      // never gets clipped by another comment that happens to sit nearby.
      data-visual-comment-dot="true"
      {...stylex.props(styles.collapsedRoot, stylex.defaultMarker())}
      style={{ left: pin.x, top: pin.y }}
    >
      <button
        type="button"
        aria-label={`Collapsed comment by ${comment.authorName ?? 'reviewer'}`}
        {...stylex.props(styles.collapsedPin)}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        <span {...stylex.props(styles.pinDot, styles.collapsedDot)} />
      </button>
      <div {...stylex.props(styles.peek, originStyle)} style={peekStyle}>
        <button
          type="button"
          {...stylex.props(styles.peekCard)}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          <div {...stylex.props(styles.peekHeader)}>
            <span
              aria-hidden
              {...stylex.props(styles.peekAvatar)}
              style={getAuthorAvatarStyle(comment)}
            >
              {getInitials(comment)}
            </span>
            <div {...stylex.props(styles.textColumn)}>
              <p {...stylex.props(styles.peekAuthor)}>
                <span {...stylex.props(styles.truncate)}>{comment.authorName ?? 'Reviewer'}</span>
              </p>
              <p {...stylex.props(styles.peekBody)}>{comment.body}</p>
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}

const DARK =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

const styles = stylex.create({
  root: { pointerEvents: 'none', position: 'absolute', inset: 0, overflow: 'hidden' },
  pin: {
    pointerEvents: 'auto',
    position: 'absolute',
    translate: '-50% -50%',
    cursor: 'pointer',
    padding: themeSpace[1.5],
  },
  pinDot: {
    display: 'block',
    width: themeSpace[3],
    height: themeSpace[3],
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: 'var(--color-amber-500, oklch(76.9% 0.188 70.08))',
    boxShadow: `0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 2px ${themeColors.background}, 0 0 #0000`,
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing.out,
  },
  activeDot: { scale: '1.25' },
  inactiveDot: { scale: { default: 'none', '@media (hover: hover)': { ':hover': '1.1' } } },
  card: {
    pointerEvents: 'auto',
    position: 'absolute',
    overflow: 'hidden',
    borderRadius: themeRadius.xl,
    backgroundColor: themeColors.popover,
    color: themeColors.popoverForeground,
    transitionProperty: 'box-shadow',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  activeCard: {
    boxShadow: `0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 1px color-mix(in oklab, ${themeColors.ring} 50%, transparent), 0 18px 45px rgba(15,23,42,0.18)`,
  },
  inactiveCard: {
    boxShadow: {
      default: `0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 1px ${themeColors.border}, 0 10px 30px rgba(15,23,42,0.12)`,
      '@media (hover: hover)': {
        ':hover': `0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 1px ${themeColors.border}, 0 14px 36px rgba(15,23,42,0.14)`,
      },
    },
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: themeSpace[2.5],
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[3],
  },
  avatar: {
    marginTop: themeSpace[0.5],
    display: 'flex',
    width: themeSpace[6],
    height: themeSpace[6],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    fontSize: '10px',
    fontWeight: themeFontWeight.semibold,
    letterSpacing: '0.025em',
    color: 'white',
  },
  textColumn: { minWidth: 0, flex: '1 1 0%' },
  author: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
    fontSize: themeFontSize.xs,
    lineHeight: themeSpace[4],
    fontWeight: themeFontWeight.semibold,
    color: themeColors.popoverForeground,
  },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  body: {
    marginTop: themeSpace[1],
    whiteSpace: 'pre-line',
    overflowWrap: 'break-word',
    fontSize: '13px',
    lineHeight: themeSpace[5],
    color: 'hsl(var(--popover-foreground) / 0.8)',
  },
  collapseButton: {
    marginRight: 'calc(var(--spacing) * -1)',
    marginTop: 'calc(var(--spacing) * -0.5)',
    display: 'inline-flex',
    width: themeSpace[6],
    height: themeSpace[6],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.md,
    color: { default: themeColors.mutedForeground, ':hover': themeColors.popoverForeground },
    backgroundColor: { default: null, ':hover': themeColors.hover },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  closeIcon: { width: themeSpace[3.5], height: themeSpace[3.5] },
  footer: {
    marginTop: themeSpace[2],
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[1],
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderColor: themeColors.border,
    paddingInline: themeSpace[1.5],
    paddingBlock: themeSpace[1],
  },
  action: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[1],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[1],
    fontSize: '11px',
    fontWeight: themeFontWeight.medium,
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  sentAction: { cursor: 'default', color: themeColors.mutedForeground },
  sendAction: {
    color: {
      default: themeColors.mutedForeground,
      '@media (hover: hover)': { ':hover': themeColors.popoverForeground },
    },
    backgroundColor: { default: null, '@media (hover: hover)': { ':hover': themeColors.hover } },
  },
  positiveAction: {
    color: {
      default: 'var(--color-emerald-700, oklch(50.8% 0.118 165.612))',
      [DARK]: 'var(--color-emerald-300, oklch(84.5% 0.143 164.978))',
    },
    backgroundColor: {
      default: null,
      '@media (hover: hover)': { ':hover': 'var(--color-emerald-50, oklch(97.9% 0.021 166.113))' },
      [DARK]: {
        default: null,
        '@media (hover: hover)': {
          ':hover':
            'color-mix(in oklab, var(--color-emerald-500, oklch(69.6% 0.17 162.48)) 10%, transparent)',
        },
      },
    },
  },
  actionIcon: { width: themeSpace[3], height: themeSpace[3] },
  sendIcon: { width: themeSpace[3], height: themeSpace[3], scale: '-1 1' },
  collapsedRoot: {
    pointerEvents: 'none',
    position: 'absolute',
    zIndex: { default: 30, ':hover': 90, ':focus-within': 90 },
  },
  collapsedPin: {
    pointerEvents: 'auto',
    position: 'absolute',
    translate: '-50% -50%',
    cursor: 'pointer',
    padding: themeSpace[2],
  },
  collapsedDot: {
    width: themeSpace[2.5],
    height: themeSpace[2.5],
    scale: {
      default: 'none',
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-visual-comment-dot]):hover')]: '1.6',
      },
      [stylex.when.ancestor(':is([data-visual-comment-dot]):focus-within')]: '1.6',
    },
  },
  peek: {
    position: 'absolute',
    pointerEvents: {
      default: 'none',
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-visual-comment-dot]):hover')]: 'auto',
      },
      [stylex.when.ancestor(':is([data-visual-comment-dot]):focus-within')]: 'auto',
    },
    scale: {
      default: '0.9',
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-visual-comment-dot]):hover')]: '1',
      },
      [stylex.when.ancestor(':is([data-visual-comment-dot]):focus-within')]: '1',
    },
    opacity: {
      default: 0,
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-visual-comment-dot]):hover')]: 1,
      },
      [stylex.when.ancestor(':is([data-visual-comment-dot]):focus-within')]: 1,
    },
    transitionProperty: 'all',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing.out,
  },
  peekTopLeft: { transformOrigin: '0 0' },
  peekTopRight: { transformOrigin: '100% 0' },
  peekBottomLeft: { transformOrigin: '0 100%' },
  peekBottomRight: { transformOrigin: '100% 100%' },
  peekCard: {
    display: 'block',
    width: '100%',
    overflow: 'hidden',
    borderRadius: themeRadius.lg,
    backgroundColor: themeColors.popover,
    textAlign: 'left',
    color: themeColors.popoverForeground,
    boxShadow: {
      default: `0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 1px ${themeColors.border}, 0 12px 30px rgba(15,23,42,0.18)`,
      '@media (hover: hover)': {
        ':hover': `0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 1px ${themeColors.border}, 0 18px 40px rgba(15,23,42,0.22)`,
        ':focus:hover':
          '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 18px 40px rgba(15,23,42,0.22)',
      },
      // The app's global :focus reset removes the original Tailwind ring, while its shadow survives.
      ':focus': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 12px 30px rgba(15,23,42,0.18)',
    },
    transitionProperty: 'box-shadow',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  peekHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: themeSpace[2],
    paddingInline: themeSpace[2.5],
    paddingBlock: themeSpace[2],
  },
  peekAvatar: {
    marginTop: themeSpace[0.5],
    display: 'flex',
    width: themeSpace[5],
    height: themeSpace[5],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    fontSize: '9px',
    fontWeight: themeFontWeight.semibold,
    letterSpacing: '0.025em',
    color: 'white',
  },
  peekAuthor: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
    fontSize: '11px',
    lineHeight: themeSpace[4],
    fontWeight: themeFontWeight.semibold,
    color: themeColors.popoverForeground,
  },
  peekBody: {
    marginTop: themeSpace[0.5],
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    fontSize: '12px',
    lineHeight: 1.375,
    color: 'hsl(var(--popover-foreground) / 0.75)',
  },
});
