import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type TouchEvent,
} from 'react';
import { animate, motion, useMotionValue, useTransform } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { canUseSidebarSwipeOpenGesture } from '@/lib/native-platform';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeEasing, themeSpace } from '../../style/theme-scale.stylex';

const styles = stylex.create({
  edgeZone: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    zIndex: 30,
    width: themeSpace[7],
  },
  scrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgb(0 0 0 / 0.6)',
    transitionProperty: 'opacity',
    transitionDuration: '150ms',
    transitionTimingFunction: themeEasing['in-out'],
  },
  scrimInteractive: {
    pointerEvents: 'auto',
  },
  scrimIdle: {
    pointerEvents: 'none',
  },
  container: {
    pointerEvents: 'none',
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 40,
    overflow: 'hidden',
    visibility: 'hidden',
  },
  containerVisible: {
    visibility: 'visible',
  },
  containerInteractive: {
    pointerEvents: 'auto',
    visibility: 'visible',
  },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    display: 'flex',
    height: '100%',
    minWidth: 0,
    overflow: 'hidden',
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    backgroundColor: themeColors.background,
    boxShadow: '0 25px 50px -12px rgb(0 0 0 / 0.25)',
  },
  panelBody: {
    minHeight: 0,
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
  },
});

const EDGE_SWIPE_ZONE_PX = 28;
const OPEN_THRESHOLD_RATIO = 0.42;
const OPEN_VELOCITY_THRESHOLD_PX_PER_MS = 0.45;
const MAX_VERTICAL_DRIFT_PX = 48;

/** Non-edge swipe: minimum horizontal distance to trigger open */
const NON_EDGE_MIN_SWIPE_PX = 64;
/** Non-edge swipe: maximum vertical drift allowed */
const NON_EDGE_MAX_VERTICAL_DRIFT_PX = 36;
const FALLBACK_VIEWPORT_WIDTH = 400;
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'password', 'tel', 'number']);
const SIDEBAR_SWIPE_OPEN_DISABLED_ATTR = 'data-sidebar-swipe-open-disabled';

type SwipeGestureElementLike = {
  tagName?: string | null;
  type?: string | null;
  isContentEditable?: boolean;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  dataset?: Record<string, string | undefined> | null;
  getAttribute?: (name: string) => string | null;
  parentElement?: SwipeGestureElementLike | null;
};

type SelectionLike = {
  rangeCount?: number;
  isCollapsed?: boolean;
};

type SwipeGestureDocumentLike = {
  activeElement: SwipeGestureElementLike | null;
  getSelection: () => SelectionLike | null;
};

function isSwipeGestureElementLike(value: unknown): value is SwipeGestureElementLike {
  return typeof value === 'object' && value !== null;
}

function getNormalizedTagName(value: unknown): string | null {
  if (!isSwipeGestureElementLike(value) || typeof value.tagName !== 'string') {
    return null;
  }
  return value.tagName.toUpperCase();
}

function hasExpandedSelectionRange(value: unknown): boolean {
  if (!isSwipeGestureElementLike(value)) {
    return false;
  }

  const selectionStart = value.selectionStart;
  const selectionEnd = value.selectionEnd;
  return (
    typeof selectionStart === 'number' &&
    typeof selectionEnd === 'number' &&
    selectionEnd > selectionStart
  );
}

function isTextInputElement(value: unknown): boolean {
  if (!isSwipeGestureElementLike(value)) {
    return false;
  }

  const tagName = getNormalizedTagName(value);
  if (tagName === 'TEXTAREA') {
    return true;
  }

  if (tagName !== 'INPUT') {
    return false;
  }

  const inputType = typeof value.type === 'string' ? value.type.toLowerCase() : 'text';
  return TEXT_INPUT_TYPES.has(inputType);
}

function isEditableTextTarget(value: unknown): boolean {
  if (!isSwipeGestureElementLike(value)) {
    return false;
  }

  return isTextInputElement(value) || value.isContentEditable === true;
}

function hasEditableTextAncestor(target: EventTarget | null): boolean {
  let current: SwipeGestureElementLike | null = isSwipeGestureElementLike(target) ? target : null;

  while (current) {
    if (isEditableTextTarget(current)) {
      return true;
    }
    current = current.parentElement ?? null;
  }

  return false;
}

function hasSidebarSwipeOpenDisabledAncestor(target: EventTarget | null): boolean {
  let current: SwipeGestureElementLike | null = isSwipeGestureElementLike(target) ? target : null;

  while (current) {
    if (typeof current.getAttribute === 'function') {
      if (current.getAttribute(SIDEBAR_SWIPE_OPEN_DISABLED_ATTR) !== null) {
        return true;
      }
    } else if (current.dataset?.sidebarSwipeOpenDisabled !== undefined) {
      return true;
    }
    current = current.parentElement ?? null;
  }

  return false;
}

export function hasActiveTextSelection(doc: SwipeGestureDocumentLike): boolean {
  if (hasExpandedSelectionRange(doc.activeElement)) {
    return true;
  }

  const selection = doc.getSelection();
  return Boolean(
    selection && selection.rangeCount && selection.rangeCount > 0 && !selection.isCollapsed
  );
}

export function shouldIgnoreSidebarSwipeGesture(
  doc: SwipeGestureDocumentLike,
  target: EventTarget | null
): boolean {
  return (
    hasActiveTextSelection(doc) ||
    hasEditableTextAncestor(target) ||
    hasSidebarSwipeOpenDisabledAncestor(target)
  );
}

/** Check if an element or any ancestor is horizontally scrollable */
function hasHorizontalScroll(el: EventTarget | null): boolean {
  let node = el instanceof Element ? el : null;
  while (node) {
    if (node.scrollWidth > node.clientWidth) {
      const style = getComputedStyle(node);
      const overflow = style.overflowX;
      if (overflow === 'auto' || overflow === 'scroll') {
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

type EdgeSwipeState = {
  startX: number;
  startY: number;
  lastX: number;
  lastTimestamp: number;
  velocityX: number;
};

type NonEdgeSwipeState = {
  startX: number;
  startY: number;
  triggered: boolean;
};

const MAX_WIDTH_RATIO = 0.8;

export function resolveMobileDrawerWidth(preferredWidth: number, viewportWidth: number): number {
  return Math.min(preferredWidth, Math.floor(viewportWidth * MAX_WIDTH_RATIO));
}

export function getMobileSidebarDrawerPanelClassName(): string {
  return stylex.props(styles.panel).className ?? '';
}

export function MobileSidebarDrawer({
  open,
  onOpenChange,
  width: preferredWidth = 280,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  width?: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  /* Swipe-to-open is disabled across every mobile surface as of the
     2026-05 mobile redesign — the sidebar is now reached via explicit
     navigation chips (workspace switcher, project rows on the home
     screen, back chip on session/project details). Keeping the gesture
     handlers in the codebase but gated on this flag lets us flip the
     behavior back if the redesign needs to revert without restoring
     a lot of touchstart / pan code. See `canUseSidebarSwipeOpenGesture`
     in `@/lib/native-platform` for the underlying platform detection
     it would otherwise resolve to. */
  void canUseSidebarSwipeOpenGesture;
  const swipeOpenEnabled = false;

  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : FALLBACK_VIEWPORT_WIDTH
  );

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const width = useMemo(
    () => resolveMobileDrawerWidth(preferredWidth, viewportWidth),
    [preferredWidth, viewportWidth]
  );

  const drawerX = useMotionValue(open ? 0 : -width);
  const overlayOpacity = useTransform(drawerX, [-width, 0], [0, 0.28]);
  const swipeStateRef = useRef<EdgeSwipeState | null>(null);
  const animationStopRef = useRef<(() => void) | null>(null);
  const animationTokenRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isVisible, setIsVisible] = useState(open);

  const stopAnimation = useCallback(() => {
    animationTokenRef.current += 1;
    animationStopRef.current?.();
    animationStopRef.current = null;
  }, []);

  const animateDrawer = useCallback(
    (targetX: number) => {
      stopAnimation();
      const animationToken = animationTokenRef.current;
      if (targetX > -width) {
        setIsVisible(true);
      }
      const controls = animate(drawerX, targetX, {
        type: 'spring',
        stiffness: 520,
        damping: 44,
        mass: 0.9,
        onComplete: () => {
          if (animationToken !== animationTokenRef.current) {
            return;
          }
          animationStopRef.current = null;
          if (targetX <= -width) {
            setIsVisible(false);
          }
        },
      });
      animationStopRef.current = () => controls.stop();
    },
    [drawerX, stopAnimation, width]
  );

  useEffect(() => {
    if (isDragging) {
      return;
    }
    animateDrawer(open ? 0 : -width);
  }, [animateDrawer, isDragging, open, width]);

  useEffect(() => {
    return () => {
      stopAnimation();
    };
  }, [stopAnimation]);

  const resetSwipe = useCallback(() => {
    swipeStateRef.current = null;
  }, []);

  const finishSwipe = useCallback(
    (forceOpen?: boolean) => {
      const swipeState = swipeStateRef.current;
      const revealedWidth = width + drawerX.get();
      const shouldOpen =
        forceOpen ??
        Boolean(
          swipeState &&
          (revealedWidth >= width * OPEN_THRESHOLD_RATIO ||
            (swipeState.velocityX >= OPEN_VELOCITY_THRESHOLD_PX_PER_MS &&
              revealedWidth >= width * 0.18))
        );

      resetSwipe();
      setIsDragging(false);
      onOpenChange(shouldOpen);
      animateDrawer(shouldOpen ? 0 : -width);
    },
    [animateDrawer, drawerX, onOpenChange, resetSwipe, width]
  );

  const cancelSwipe = useCallback(() => {
    resetSwipe();
    setIsDragging(false);
    animateDrawer(open ? 0 : -width);
  }, [animateDrawer, open, resetSwipe, width]);

  // --- Non-edge swipe (anywhere on screen, opens with animation directly) ---
  const nonEdgeSwipeRef = useRef<NonEdgeSwipeState | null>(null);

  useEffect(() => {
    if (open || !swipeOpenEnabled) {
      nonEdgeSwipeRef.current = null;
      return undefined;
    }

    const handleTouchStart = (event: globalThis.TouchEvent) => {
      if (event.touches.length !== 1) {
        return;
      }

      if (shouldIgnoreSidebarSwipeGesture(document, event.target)) {
        return;
      }

      const touch = event.touches[0];
      if (!touch || touch.clientX <= EDGE_SWIPE_ZONE_PX) {
        return;
      }

      // Skip if touch started inside a horizontally scrollable container
      if (hasHorizontalScroll(event.target)) {
        return;
      }

      nonEdgeSwipeRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        triggered: false,
      };
    };

    const handleTouchMove = (event: globalThis.TouchEvent) => {
      const state = nonEdgeSwipeRef.current;
      if (!state || state.triggered || event.touches.length !== 1) {
        return;
      }

      if (hasActiveTextSelection(document)) {
        nonEdgeSwipeRef.current = null;
        return;
      }

      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      const deltaX = touch.clientX - state.startX;
      const deltaY = Math.abs(touch.clientY - state.startY);

      if (deltaY > NON_EDGE_MAX_VERTICAL_DRIFT_PX && deltaY > Math.abs(deltaX)) {
        nonEdgeSwipeRef.current = null;
        return;
      }

      if (deltaX >= NON_EDGE_MIN_SWIPE_PX) {
        state.triggered = true;
        onOpenChange(true);
      }
    };

    const handleTouchEnd = () => {
      nonEdgeSwipeRef.current = null;
    };

    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: true });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });
    document.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [open, onOpenChange, swipeOpenEnabled]);

  // --- Edge swipe (left edge, tracks finger position) ---
  const handleEdgeTouchStart = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      if (!swipeOpenEnabled || open || event.touches.length !== 1) {
        return;
      }

      if (shouldIgnoreSidebarSwipeGesture(document, event.target)) {
        return;
      }

      const touch = event.touches[0];
      if (!touch || touch.clientX > EDGE_SWIPE_ZONE_PX) {
        return;
      }

      stopAnimation();
      swipeStateRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        lastTimestamp: performance.now(),
        velocityX: 0,
      };
      setIsVisible(true);
      setIsDragging(true);
      drawerX.set(-width);
    },
    [drawerX, open, stopAnimation, swipeOpenEnabled, width]
  );

  const handleEdgeTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const swipeState = swipeStateRef.current;
      if (!swipeState || event.touches.length !== 1) {
        return;
      }

      if (hasActiveTextSelection(document)) {
        cancelSwipe();
        return;
      }

      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      const deltaX = touch.clientX - swipeState.startX;
      const deltaY = Math.abs(touch.clientY - swipeState.startY);

      if (deltaY > MAX_VERTICAL_DRIFT_PX && deltaY > Math.abs(deltaX)) {
        cancelSwipe();
        return;
      }

      const nextReveal = Math.min(Math.max(deltaX, 0), width);
      const nextTimestamp = performance.now();
      const elapsedMs = Math.max(nextTimestamp - swipeState.lastTimestamp, 1);
      swipeState.velocityX = Math.max((touch.clientX - swipeState.lastX) / elapsedMs, 0);
      swipeState.lastX = touch.clientX;
      swipeState.lastTimestamp = nextTimestamp;

      if (nextReveal > 0) {
        event.preventDefault();
      }

      drawerX.set(nextReveal - width);
    },
    [cancelSwipe, drawerX, width]
  );

  const handleEdgeTouchEnd = useCallback(() => {
    if (!swipeStateRef.current) {
      return;
    }
    finishSwipe();
  }, [finishSwipe]);

  const isInteractive = open || isDragging;
  const isPresent = isInteractive || isVisible;

  return (
    <>
      {!open && swipeOpenEnabled && (
        <div
          {...stylex.props(styles.edgeZone)}
          style={{ touchAction: 'pan-y' }}
          onTouchStart={handleEdgeTouchStart}
          onTouchMove={handleEdgeTouchMove}
          onTouchEnd={handleEdgeTouchEnd}
          onTouchCancel={cancelSwipe}
        />
      )}

      <div
        {...stylex.props(
          styles.container,
          isInteractive ? styles.containerInteractive : isPresent ? styles.containerVisible : false
        )}
        role={isInteractive ? 'dialog' : undefined}
        aria-modal={isInteractive ? true : undefined}
        aria-label={isInteractive ? t('sidebar.navigationMenu', 'Navigation Menu') : undefined}
        aria-hidden={!isInteractive}
      >
        <motion.button
          type="button"
          aria-label={t('sidebar.closeNavigationMenu', 'Close navigation menu')}
          {...stylex.props(
            styles.scrim,
            isInteractive ? styles.scrimInteractive : styles.scrimIdle
          )}
          style={{ opacity: overlayOpacity }}
          onClick={() => onOpenChange(false)}
        />

        <motion.aside
          {...stylex.props(styles.panel)}
          style={{ width, maxWidth: '80vw', x: drawerX }}
        >
          {/* Let long sidebar content shrink inside the drawer instead of leaking past the 80vw cap. */}
          <div {...stylex.props(styles.panelBody)}>{children}</div>
        </motion.aside>
      </div>
    </>
  );
}
