import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { animate, motion, useMotionValue, useTransform } from 'framer-motion';
import { useDrag } from '@use-gesture/react';
import { useTranslation } from 'react-i18next';
import { Archive, ArchiveRestore, Pin, PinOff, Trash2 } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';

import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontWeight, themeSpace } from '../../style/theme-scale.stylex';
import { withClassName } from '@/lib/stylex';

/**
 * iOS-style swipe-to-reveal-actions wrapper for a list row.
 *
 * Two variants:
 *  - `active` (default): left-swipe exposes a pin / unpin chip on the
 *    left and an archive chip on the right. Continuing past
 *    `AUTO_ARCHIVE_AT` grows the archive chip and releasing there fires
 *    `onArchive` immediately (no second tap), mirroring iOS Mail's
 *    super-swipe.
 *  - `archived`: left-swipe exposes a restore chip on the left and a
 *    delete chip on the right. No super-swipe — permanent delete is
 *    irreversible, so it always goes through the caller's confirmation
 *    (the chip just fires `onDelete`), never an accidental long-drag.
 *
 * Konsta doesn't ship a swipe-action primitive — this is custom but
 * tries to feel native:
 *  - Drag tracks the finger 1:1 (no rubber-banding on the negative
 *    direction; rightward drag past the snap-closed position is
 *    clamped so the row never reveals on the wrong side).
 *  - Spring snap-back / snap-open on release.
 *  - Tap-through preserved: when the user just taps the row (no
 *    horizontal movement) `useDrag`'s `filterTaps` lets the row's
 *    own onClick fire.
 *  - Vertical scrolling lives separately: we set `touchAction:
 *    pan-y` so swipes that have a vertical component pass through
 *    to the scroll container.
 */
export type MobileSwipeableRowProps = {
  children: ReactNode;
  /** Which action set the drawer reveals. Defaults to `active`
     (pin + archive). `archived` swaps in restore + delete for the
     archived-conversation list. */
  variant?: 'active' | 'archived';
  isPinned?: boolean;
  onTogglePin?: () => void;
  onArchive?: () => void;
  /** Archived-variant actions. `onRestore` un-archives the row;
     `onDelete` asks the caller to confirm + permanently delete it. */
  onRestore?: () => void;
  onDelete?: () => void;
  /** Labels surfaced as visible text + aria-label + tooltip on each action chip. */
  pinAriaLabel?: string;
  unpinAriaLabel?: string;
  archiveAriaLabel?: string;
  restoreAriaLabel?: string;
  deleteAriaLabel?: string;
  /**
   * Lift the row face above the drill-page back-swipe strip
   * (`mobile-edge-back-swipe.tsx`, mounted at `zIndex={20}`). The face is
   * normally `z-10`, so it AND everything inside it — including a control
   * rendered by `children` — sits under that strip and cannot be tapped in
   * the leading 48px on a native drill page.
   *
   * Set this only for a row that actually puts a control there (today: an
   * opened-by tree opener's fold chevron). The trade is that an edge swipe
   * starting on this row no longer navigates back; every other row still
   * does, and the header back chip is unaffected. Same trade the composer
   * makes with `protectFromEdgeBackZone`.
   */
  liftAboveEdgeSwipeZone?: boolean;
  className?: string;
};

/* Width (in CSS px) of each action chip when the row is in its
   "snap-open" state. Two chips = 2 × 64 = 128px revealed — narrower
   than iOS Mail's defaults but lines up better with our compact row
   typography (short localized action labels fit at this width). */
const ACTION_WIDTH = 64;
const TOTAL_ACTION_WIDTH = ACTION_WIDTH * 2;

/* Drag-position thresholds:
   - SNAP_OPEN_AT: while dragging, anything past this commits to the
     fully-revealed state on release; below it snaps back closed.
   - AUTO_ARCHIVE_AT: past this point the archive chip expands to
     fill the revealed area (pin hides) and releasing fires
     `onArchive` immediately. Chosen as ~60% of typical phone width
     so a deliberate long swipe gets the super-swipe behavior. */
const SNAP_OPEN_AT = TOTAL_ACTION_WIDTH * 0.4;
const AUTO_ARCHIVE_AT = 240;

const SPRING = { type: 'spring' as const, stiffness: 260, damping: 32, mass: 0.7 };

const styles = stylex.create({
  /** The row's shell: the drawer slides out under the face. */
  root: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: themeColors.background,
  },
  /** The drawer under the row face. */
  drawer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    zIndex: 0,
    display: 'flex',
    pointerEvents: 'none',
  },
  /** The drawer's chips. */
  drawerChips: {
    display: 'flex',
    height: '100%',
  },
  /** The drawer, once the row is open. */
  drawerOpen: { pointerEvents: 'auto' },
  /** One action chip. */
  chip: {
    display: 'flex',
    flexShrink: 0,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[1],
  },
  /** The chip's glyph. */
  chipGlyph: {
    width: themeSpace[5],
    height: themeSpace[5],
  },
  /** The chip's label. */
  chipLabel: {
    fontSize: '0.72rem',
    fontWeight: themeFontWeight.medium,
    lineHeight: 1,
  },
  /** The chip that restores a closed conversation. */
  chipRestore: {
    backgroundColor: themeColors.primary,
    color: themeColors.primaryForeground,
  },
  /** The chip that deletes a closed conversation. */
  chipDelete: {
    backgroundColor: themeColors.destructive,
    color: themeColors.destructiveForeground,
  },
  /** The chip that pins a conversation. */
  chipPin: {
    backgroundColor: themeColors.primary,
    color: themeColors.primaryForeground,
  },
  /** The chip that archives a conversation. */
  chipArchive: {
    backgroundColor: themeColors.destructive,
    color: themeColors.destructiveForeground,
  },
  /** The archive chip, grown to eat the pin's slot in a super-swipe. */
  chipArchiveSuper: {
    alignItems: 'flex-start',
    paddingInlineStart: themeSpace[5],
  },
  /** The row's face: it slides, and it carries the row's own hairline. */
  face: {
    position: 'relative',
    width: '100%',
    backgroundColor: themeColors.background,
    boxShadow: '0 1px 0 0 hsl(var(--background)), 0 -1px 0 0 hsl(var(--background))',
  },
  /** The face at rest: under the drill page's back-swipe strip. */
  faceBase: { zIndex: 10 },
  /** The face, lifted above the back-swipe strip. */
  faceLifted: { zIndex: 30 },
});

/* --------------------------------------------------------------------------
 * Group registry — coordinates "only one row open at a time" across all
 * swipeable rows inside a `MobileSwipeableRowGroup` boundary. Rejected
 * alternatives:
 *   - Module-level singleton: would couple unrelated lists (e.g. two
 *     scrollable sections on different screens would close each other).
 *   - Top-down controlled `openRowId` prop: forces every parent list to
 *     wire ids through, which leaks state that should be internal.
 *   - Imperative ref array: harder to swap rows in/out (mount/unmount
 *     ordering races during list updates). The registry's Map keeps
 *     registration cheap and order-agnostic. */
type SwipeableRowRegistry = {
  /** A row calls this whenever it begins a horizontal swipe (drag start)
     or commits to the open state. The registry closes any other row
     that's currently active. Called with the calling row's id so the
     registry can skip closing it. */
  notifyActive: (rowId: string) => void;
  /** Register the row's `close()` so the registry can drive it from
     outside. Returns an unregister function. */
  register: (rowId: string, close: () => void) => () => void;
};

const SwipeableRowContext = createContext<SwipeableRowRegistry | null>(null);

/**
 * Wraps a list of `MobileSwipeableRow`s and enforces iOS-style
 * "only one row open at a time": opening or starting to drag a new
 * row auto-closes whichever row was previously open. Without this
 * wrapper each row works standalone (no cross-coordination).
 */
export function MobileSwipeableRowGroup({ children }: { children: ReactNode }) {
  const rowsRef = useRef(new Map<string, () => void>());
  const activeRowRef = useRef<string | null>(null);

  const registry = useMemo<SwipeableRowRegistry>(
    () => ({
      notifyActive: (rowId) => {
        const prevId = activeRowRef.current;
        if (prevId && prevId !== rowId) {
          rowsRef.current.get(prevId)?.();
        }
        activeRowRef.current = rowId;
      },
      register: (rowId, close) => {
        rowsRef.current.set(rowId, close);
        return () => {
          rowsRef.current.delete(rowId);
          if (activeRowRef.current === rowId) {
            activeRowRef.current = null;
          }
        };
      },
    }),
    []
  );

  return <SwipeableRowContext.Provider value={registry}>{children}</SwipeableRowContext.Provider>;
}

export function MobileSwipeableRow({
  children,
  variant = 'active',
  isPinned,
  onTogglePin,
  onArchive,
  onRestore,
  onDelete,
  pinAriaLabel,
  unpinAriaLabel,
  archiveAriaLabel,
  restoreAriaLabel,
  deleteAriaLabel,
  liftAboveEdgeSwipeZone = false,
  className,
}: MobileSwipeableRowProps) {
  const { t } = useTranslation();
  const archivedVariant = variant === 'archived';
  /* `x` is the horizontal translation of the row content. Negative
     values reveal the drawer on the right. The actions drawer reads
     `-x` to size itself / decide whether to enter super-swipe state. */
  const x = useMotionValue(0);
  const [superSwipe, setSuperSwipe] = useState(false);
  /* Tracks whether the row is in the snap-open state (drawer
     persistently visible). Used to drive the row's onClick: when
     open, a tap on the row closes the drawer instead of firing the
     row's own click handler. */
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  /* `useId` gives a stable per-instance id we use as the registry key
     so the group wrapper can address each row without the caller
     having to thread an id through. The registry is optional (rows
     work standalone if there's no `MobileSwipeableRowGroup` ancestor). */
  const rowId = useId();
  const registry = useContext(SwipeableRowContext);

  /* Mirror the live drag into the React `superSwipe` state so the
     drawer can flip its layout. `useMotionValue`'s subscription
     fires on every frame without forcing a re-render — the
     `useTransform` below would be cleaner, but we need the boolean
     in a click handler too. */
  useEffect(() => {
    /* Super-swipe only exists in the active variant — the archived
       variant has no auto-action (delete must be confirmed), so its
       chips stay fixed-width and never enter the grow state. */
    const unsub = x.on('change', (value) => {
      setSuperSwipe(!archivedVariant && -value >= AUTO_ARCHIVE_AT);
    });
    return unsub;
  }, [x, archivedVariant]);

  /* Chip widths are wired together so the drawer's total width tracks
     the row's translation exactly — otherwise the leftmost chip ends
     up behind the still-visible row content and disappears. Two modes:

     - Normal drag (below super-swipe threshold): both chips stay at
       ACTION_WIDTH (64). Drawer total = 128, matching the snap-open
       offset so both chips sit fully inside the revealed area.
     - Super-swipe: pin chip collapses to 0 width AND opacity 0, and
       the archive chip grows to fill the entire dragged distance, so
       it visually "eats" the pin slot. Rejected alternative: leave
       pin at fixed width with archive growing past it — drawer ends
       up wider than the revealed area and the pin gets clipped under
       the row content. */
  const pinWidth = useTransform(x, (value) => (-value >= AUTO_ARCHIVE_AT ? 0 : ACTION_WIDTH));
  const pinOpacity = useTransform(x, (value) => (-value >= AUTO_ARCHIVE_AT ? 0 : 1));
  const archiveWidth = useTransform(x, (value) => {
    const dragged = -value;
    return dragged >= AUTO_ARCHIVE_AT ? dragged : ACTION_WIDTH;
  });
  /* Hide the entire action drawer when fully closed. Otherwise primary /
     destructive chip colors leak as 1px horizontal "dividers" on the
     right edge of every row (subpixel gaps between sliding face and
     shell during layout / high-DPI rounding). Any open drag (x < -1)
     reveals the drawer again. */
  const drawerOpacity = useTransform(x, (value) => (value < -1 ? 1 : 0));

  const closeDrawer = () => {
    setOpen(false);
    void animate(x, 0, SPRING);
  };
  const openDrawer = () => {
    setOpen(true);
    void animate(x, -TOTAL_ACTION_WIDTH, SPRING);
  };

  /* Register this row's `close()` with the group so a sibling row can
     drive it closed when it becomes the active row. Re-register on
     each render so the closure captures the current `x` reference;
     `useEffect` strictly speaking would suffice but registering in a
     layout-stable effect keeps the registry consistent with React's
     commit phase. */
  useEffect(() => {
    if (!registry) return undefined;
    return registry.register(rowId, () => {
      setOpen(false);
      void animate(x, 0, SPRING);
    });
  }, [registry, rowId, x]);

  const bindDrag = useDrag(
    ({ first, active, movement: [movementX, movementY], last, cancel, event }) => {
      /* The gesture lib's `filterTaps` already drops zero-movement
         taps; we just need to keep vertical drags from translating
         the row. If the user's first move is dominantly vertical,
         cancel — they're scrolling. */
      if (first && Math.abs(movementY) > Math.abs(movementX)) {
        cancel();
        return;
      }
      if (first) {
        /* First horizontal-committed frame on this row — tell the
           group to close any other row that's currently open. We do
           this before `x.set` so the close animation starts in the
           same frame the user begins revealing this row's drawer. */
        registry?.notifyActive(rowId);
      }
      if (active) {
        /* Base position is wherever the row currently sits — when
           the drawer is open, additional drag is relative to the
           open offset. Clamp positive (right) drag to 0 so the row
           can't reveal on the wrong side. */
        const base = open ? -TOTAL_ACTION_WIDTH : 0;
        let next = Math.min(0, base + movementX);
        /* The archived variant has fixed-width chips (no super-swipe
           growth), so over-dragging past the drawer would expose a
           blank gap behind the row. Clamp it to the fully-open width;
           the active variant stays unclamped so its archive chip can
           grow during a super-swipe. */
        if (archivedVariant) next = Math.max(-TOTAL_ACTION_WIDTH, next);
        x.set(next);
        if (Math.abs(movementX) > 8) event.preventDefault();
        return;
      }
      if (last) {
        const final = x.get();
        if (!archivedVariant && -final >= AUTO_ARCHIVE_AT && onArchive) {
          /* Fire the archive immediately so the list-level height
             collapse animation (see `ROW_EXIT_TRANSITION` in
             mobile-chat-list.tsx) is what the user sees, not a
             slide-off-screen.

             Rejected: animating `x` to `-width` first and then
             archiving on `.then()`. With that flow the row content
             was already off-screen by the time the parent removed
             the row from `chats`, so the AnimatePresence exit
             collapse ran on an empty slot — the user reported the
             archive "still feels like it just disappears." Letting
             the row stay in place lets the height-collapse + opacity
             fade be the only visible feedback, which is more
             noticeable than a fleeting horizontal slide. */
          onArchive();
          return;
        }
        if (-final >= SNAP_OPEN_AT) {
          openDrawer();
        } else {
          closeDrawer();
        }
      }
    },
    {
      filterTaps: true,
      pointer: { touch: true },
      eventOptions: { passive: false },
    }
  );

  /* When the user taps the row while the drawer is open, swallow the
     tap and just close the drawer — the inner content's own onClick
     shouldn't fire. We attach a capture-phase click handler on the
     row content for this. */
  const handleCaptureClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (open) {
      event.preventDefault();
      event.stopPropagation();
      closeDrawer();
    }
  };

  const pinLabel = isPinned
    ? (unpinAriaLabel ?? t('chat.mobileHome.swipeActions.unpin', 'Unpin'))
    : (pinAriaLabel ?? t('chat.mobileHome.swipeActions.pin', 'Pin'));
  const archiveLabel = archiveAriaLabel ?? t('chat.mobileHome.swipeActions.archive', 'Archive');
  const releaseArchiveLabel = t(
    'chat.mobileHome.swipeActions.releaseToArchive',
    'Release to archive'
  );
  const restoreLabel = restoreAriaLabel ?? t('chat.mobileHome.swipeActions.restore', 'Restore');
  const deleteLabel = deleteAriaLabel ?? t('chat.mobileHome.swipeActions.delete', 'Delete');
  const activeArchiveLabel = superSwipe ? releaseArchiveLabel : archiveLabel;

  return (
    <div
      ref={containerRef}
      {...withClassName(stylex.props(styles.root), className)}
      style={{ touchAction: 'pan-y' }}
    >
      {/* Action drawer under the row face. Opacity is 0 whenever the
         face is fully closed so chip colors cannot leak as fake
         inter-row dividers on the right edge. */}
      <motion.div
        style={{ opacity: drawerOpacity }}
        aria-hidden={!open}
        {...stylex.props(styles.drawer)}
      >
        {/* Re-enable pointer events only when the drawer is snapped open
            (or mid-swipe). `open` is React state; mid-swipe still needs
            hits on chips once fully revealed — chips keep their own
            onClick and the face has already slid away. */}
        <div {...stylex.props(styles.drawerChips, open && styles.drawerOpen)}>
          {archivedVariant ? (
            <>
              {onRestore ? (
                <button
                  type="button"
                  aria-label={restoreLabel}
                  title={restoreLabel}
                  onClick={() => {
                    onRestore();
                    closeDrawer();
                  }}
                  style={{ width: ACTION_WIDTH }}
                  {...stylex.props(styles.chip, styles.chipRestore)}
                >
                  <ArchiveRestore
                    {...stylex.props(styles.chipGlyph)}
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  <span {...stylex.props(styles.chipLabel)}>{restoreLabel}</span>
                </button>
              ) : null}
              {onDelete ? (
                <button
                  type="button"
                  aria-label={deleteLabel}
                  title={deleteLabel}
                  onClick={() => {
                    onDelete();
                    closeDrawer();
                  }}
                  style={{ width: ACTION_WIDTH }}
                  {...stylex.props(styles.chip, styles.chipDelete)}
                >
                  <Trash2
                    {...stylex.props(styles.chipGlyph)}
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  <span {...stylex.props(styles.chipLabel)}>{deleteLabel}</span>
                </button>
              ) : null}
            </>
          ) : null}
          {!archivedVariant && onTogglePin ? (
            <motion.button
              type="button"
              aria-label={pinLabel}
              title={pinLabel}
              onClick={() => {
                onTogglePin();
                closeDrawer();
              }}
              style={{ width: pinWidth, opacity: pinOpacity }}
              {...stylex.props(styles.chip, styles.chipPin)}
            >
              {isPinned ? (
                <PinOff {...stylex.props(styles.chipGlyph)} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <Pin {...stylex.props(styles.chipGlyph)} strokeWidth={1.8} aria-hidden="true" />
              )}
              <span {...stylex.props(styles.chipLabel)}>{pinLabel}</span>
            </motion.button>
          ) : null}
          {!archivedVariant && onArchive ? (
            <motion.button
              type="button"
              aria-label={activeArchiveLabel}
              title={activeArchiveLabel}
              onClick={() => {
                onArchive();
                closeDrawer();
              }}
              style={{ width: archiveWidth }}
              {...stylex.props(
                styles.chip,
                styles.chipArchive,
                superSwipe && styles.chipArchiveSuper
              )}
            >
              <Archive {...stylex.props(styles.chipGlyph)} strokeWidth={1.8} aria-hidden="true" />
              <span {...stylex.props(styles.chipLabel)}>{activeArchiveLabel}</span>
            </motion.button>
          ) : null}
        </div>
      </motion.div>
      {/* Row content. The drag handlers and the translation live on
         separate elements — `useDrag`'s spread includes an `onDrag`
         that collides with framer-motion's own native-drag prop, so
         we keep them apart. Move the outer hit box with the visible
         face so it cannot cover the revealed action buttons. */}
      <motion.div
        style={{ x }}
        {...stylex.props(styles.face, liftAboveEdgeSwipeZone ? styles.faceLifted : styles.faceBase)}
      >
        <div {...bindDrag()} onClickCapture={handleCaptureClick}>
          {children}
        </div>
      </motion.div>
    </div>
  );
}
