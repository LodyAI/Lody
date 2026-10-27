import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { clamp } from '@/lib/clamp';
import { cn } from '@/lib/utils';
import * as stylex from '@stylexjs/stylex';
import { withClassName } from '@/lib/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const SWIPE_ACTION_ROW_OPEN_EVENT = 'lody:swipe-action-row-open';
const HORIZONTAL_LOCK_PX = 8;
const REVEAL_THRESHOLD_RATIO = 0.35;
const CLOSE_THRESHOLD_PX = 28;
const DEFAULT_ACTION_WIDTH = 72;
const DEFAULT_COMMIT_DISTANCE = 52;
const CLICK_SUPPRESS_MS = 350;
const styles = stylex.create({
  root: { position: 'relative', overflow: 'hidden', borderRadius: themeRadius.md },
  actions: {
    position: 'absolute',
    insetBlock: 0,
    right: 0,
    display: 'flex',
    justifyContent: 'flex-end',
    overflow: 'hidden',
    borderRadius: themeRadius.md,
  },
  action: {
    display: 'flex',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingInline: themeSpace[1.5],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    fontWeight: themeFontWeight.medium,
  },
  dragColors: {
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionTimingFunction: 'var(--tw-ease, var(--default-transition-timing-function))',
    transitionDuration: 'var(--tw-duration, var(--default-transition-duration))',
  },
  spring: {
    transitionDuration: themeDuration[300],
    transitionTimingFunction: 'cubic-bezier(0.2,1.35,0.22,1)',
  },
  actionTransition: { transitionProperty: 'width,background-color,color' },
  actionContent: {
    display: 'flex',
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[1],
  },
  noTransition: { transitionProperty: 'none' },
  actionContentTransition: { transitionProperty: 'transform, translate, scale, rotate' },
  label: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  content: {
    position: 'relative',
    zIndex: 10,
    touchAction: 'pan-y',
    backgroundColor: themeColors.background,
    willChange: 'transform',
  },
  contentTransition: { transitionProperty: 'translate,scale' },
});

export type SwipeActionRowAction = {
  key: string;
  label: string;
  ariaLabel?: string;
  icon?: ReactNode;
  hideLabel?: boolean;
  className?: string;
  onClick: () => void;
};

type SwipeGestureState = {
  pointerId: number;
  startX: number;
  startY: number;
  startOffset: number;
  lastOffset: number;
  isHorizontal: boolean;
  isOpenAtStart: boolean;
};

type SwipeActionRowProps = {
  enabled: boolean;
  actions: SwipeActionRowAction[];
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  actionWidth?: number;
  commitDistance?: number;
  onCommit?: () => void;
};

export function SwipeActionRow({
  enabled,
  actions,
  children,
  className,
  contentClassName,
  actionWidth = DEFAULT_ACTION_WIDTH,
  commitDistance = DEFAULT_COMMIT_DISTANCE,
  onCommit,
}: SwipeActionRowProps) {
  const rowId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<SwipeGestureState | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);

  const revealWidth = useMemo(() => actions.length * actionWidth, [actionWidth, actions.length]);
  const hasCommit = typeof onCommit === 'function';
  const maxSwipeWidth = revealWidth + (hasCommit ? commitDistance : 0);
  const restingOffset = isOpen ? -revealWidth : 0;
  const visualOffset = isDragging ? dragOffset : restingOffset;
  const visibleActionWidth = Math.abs(visualOffset);
  const commitStretchEnabled = hasCommit && actions.length === 1;
  const commitOverswipe = commitStretchEnabled ? Math.max(0, visibleActionWidth - revealWidth) : 0;
  const commitProgress = commitDistance > 0 ? clamp(commitOverswipe / commitDistance, [0, 1]) : 0;
  const commitActionWidth = commitStretchEnabled
    ? Math.max(actionWidth, Math.min(maxSwipeWidth, visibleActionWidth))
    : actionWidth;

  const clearSuppressClickTimer = useCallback(() => {
    if (suppressClickTimerRef.current === null) return;
    clearTimeout(suppressClickTimerRef.current);
    suppressClickTimerRef.current = null;
  }, []);

  const suppressClickBriefly = useCallback(() => {
    suppressNextClickRef.current = true;
    clearSuppressClickTimer();
    suppressClickTimerRef.current = setTimeout(() => {
      suppressNextClickRef.current = false;
      suppressClickTimerRef.current = null;
    }, CLICK_SUPPRESS_MS);
  }, [clearSuppressClickTimer]);

  const openRow = useCallback(() => {
    setIsOpen(true);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(SWIPE_ACTION_ROW_OPEN_EVENT, { detail: rowId }));
    }
  }, [rowId]);

  const closeRow = useCallback(() => {
    setIsOpen(false);
  }, []);

  useEffect(() => {
    if (!enabled && isOpen) {
      closeRow();
    }
  }, [closeRow, enabled, isOpen]);

  useEffect(() => {
    return () => {
      clearSuppressClickTimer();
    };
  }, [clearSuppressClickTimer]);

  useEffect(() => {
    if (!enabled) return undefined;

    const handleOtherRowOpen = (event: Event) => {
      const nextOpenRowId = (event as CustomEvent<string>).detail;
      if (nextOpenRowId !== rowId) {
        closeRow();
      }
    };

    window.addEventListener(SWIPE_ACTION_ROW_OPEN_EVENT, handleOtherRowOpen);
    return () => window.removeEventListener(SWIPE_ACTION_ROW_OPEN_EVENT, handleOtherRowOpen);
  }, [closeRow, enabled, rowId]);

  useEffect(() => {
    if (!enabled || !isOpen) return undefined;

    const handleOutsidePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      closeRow();
    };

    window.addEventListener('pointerdown', handleOutsidePointerDown, true);
    return () => window.removeEventListener('pointerdown', handleOutsidePointerDown, true);
  }, [closeRow, enabled, isOpen]);

  const endGesture = useCallback((target: HTMLDivElement, pointerId: number) => {
    if (target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
    gestureRef.current = null;
    setIsDragging(false);
    setDragOffset(0);
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled || revealWidth <= 0 || event.pointerType !== 'touch') return;

      gestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startOffset: isOpen ? -revealWidth : 0,
        lastOffset: isOpen ? -revealWidth : 0,
        isHorizontal: false,
        isOpenAtStart: isOpen,
      };
      setIsDragging(true);
      setDragOffset(isOpen ? -revealWidth : 0);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [enabled, isOpen, revealWidth]
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;

      const deltaX = event.clientX - gesture.startX;
      const deltaY = event.clientY - gesture.startY;
      const absDeltaX = Math.abs(deltaX);
      const absDeltaY = Math.abs(deltaY);

      if (!gesture.isHorizontal) {
        if (absDeltaX < HORIZONTAL_LOCK_PX && absDeltaY < HORIZONTAL_LOCK_PX) return;
        if (absDeltaY > absDeltaX) {
          endGesture(event.currentTarget, event.pointerId);
          return;
        }
        gesture.isHorizontal = true;
      }

      if (event.cancelable) {
        event.preventDefault();
      }

      suppressClickBriefly();
      const nextOffset = clamp(gesture.startOffset + deltaX, [-maxSwipeWidth, 0]);
      gesture.lastOffset = nextOffset;
      setDragOffset(nextOffset);
    },
    [endGesture, maxSwipeWidth, suppressClickBriefly]
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;

      const deltaX = event.clientX - gesture.startX;
      const shouldCommit =
        hasCommit && gesture.isOpenAtStart && deltaX <= -commitDistance && gesture.isHorizontal;
      const shouldOpen =
        gesture.isHorizontal &&
        (gesture.isOpenAtStart
          ? deltaX <= CLOSE_THRESHOLD_PX
          : gesture.lastOffset <= -revealWidth * REVEAL_THRESHOLD_RATIO);

      endGesture(event.currentTarget, event.pointerId);

      if (!gesture.isHorizontal) return;

      suppressClickBriefly();
      if (shouldCommit) {
        closeRow();
        onCommit?.();
        return;
      }

      if (shouldOpen) {
        openRow();
        return;
      }

      closeRow();
    },
    [
      closeRow,
      commitDistance,
      endGesture,
      hasCommit,
      onCommit,
      openRow,
      revealWidth,
      suppressClickBriefly,
    ]
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      endGesture(event.currentTarget, event.pointerId);
    },
    [endGesture]
  );

  const handleContentClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!enabled) return;

      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        clearSuppressClickTimer();
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (!isOpen) return;

      closeRow();
      event.preventDefault();
      event.stopPropagation();
    },
    [clearSuppressClickTimer, closeRow, enabled, isOpen]
  );

  if (!enabled || actions.length === 0 || revealWidth <= 0) {
    return <>{children}</>;
  }

  return (
    <div ref={rootRef} {...withClassName(stylex.props(styles.root), className)}>
      <div
        {...stylex.props(styles.actions)}
        style={{ width: maxSwipeWidth }}
        aria-hidden={!isOpen && !isDragging}
      >
        {actions.map((action, index) => {
          const shouldStretchAction = commitStretchEnabled && index === actions.length - 1;
          return (
            <button
              key={action.key}
              type="button"
              className={cn(
                stylex.props(
                  styles.action,
                  isDragging ? styles.dragColors : styles.actionTransition,
                  !isDragging && styles.spring
                ).className,
                'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60',
                action.className
              )}
              style={{ width: shouldStretchAction ? commitActionWidth : actionWidth }}
              aria-label={action.ariaLabel ?? action.label}
              tabIndex={isOpen ? 0 : -1}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                closeRow();
                action.onClick();
              }}
            >
              <span
                {...stylex.props(
                  styles.actionContent,
                  isDragging ? styles.noTransition : styles.actionContentTransition,
                  !isDragging && styles.spring
                )}
                style={
                  shouldStretchAction
                    ? {
                        transform: `translate3d(${-commitOverswipe * 0.16}px, 0, 0) scale(${
                          1 + commitProgress * 0.05
                        })`,
                      }
                    : undefined
                }
              >
                {action.icon}
                {action.hideLabel ? null : (
                  <span {...stylex.props(styles.label)}>{action.label}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div
        {...withClassName(
          stylex.props(
            styles.content,
            isDragging ? styles.noTransition : styles.contentTransition,
            !isDragging && styles.spring
          ),
          contentClassName
        )}
        style={{ transform: `translate3d(${visualOffset}px, 0, 0)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClickCapture={handleContentClickCapture}
      >
        {children}
      </div>
    </div>
  );
}
