import * as React from 'react';
import { createPortal } from 'react-dom';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { cn } from '@/lib/utils';

/* Viewport breakpoint that flips the mention menu from the desktop
   floating popover to the mobile docked panel. 640px = Tailwind `sm`;
   below it we're in the phone / bottom-sheet layout where the floating
   popover fought vaul's drag + pointer-capture and candidates couldn't
   be tapped. */
const MOBILE_QUERY = '(max-width: 639px)';

export function useIsMentionMobile(): boolean {
  const [isMobile, setIsMobile] = React.useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(MOBILE_QUERY).matches;
  });
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(MOBILE_QUERY);
    const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    setIsMobile(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return isMobile;
}

/* Breathing room: between the panel's bottom and the composer's top,
   and between the panel's top and the top safe-area / status bar. */
const PANEL_TO_COMPOSER_GAP = 8;
const PANEL_TOP_INSET = 56;
/* Absolute cap so the panel stays a compact strip even when there's
   lots of room above the composer (the list scrolls past this). */
const PANEL_MAX_HEIGHT = 220;

/**
 * Mobile presentation for the mention menu. Instead of a floating
 * popover anchored to the caret (which, inside a vaul Drawer, lost taps
 * AND scroll), this docks a full-width, scrollable panel directly ABOVE
 * the composer — so the composer stays visible just above the keyboard
 * and serves as the single-line search field: the user types there to
 * fuzzy-filter and taps a row here to insert. Reuses the exact same
 * candidate rows (`children`) and diceui selection logic.
 *
 * Why portal INTO the drawer ([data-vaul-drawer]) and not document.body:
 * vaul's modal Radix Dialog wraps the drawer content in
 * `react-remove-scroll`, which `preventDefault`s touch/wheel scrolling
 * for any target OUTSIDE the dialog content (it overrides touch-action).
 * A body portal lands outside that subtree, so the candidate list could
 * never be scrolled. Rendering inside the drawer puts the panel in the
 * allowed subtree, so it scrolls normally.
 *
 * Positioning: we use `position: absolute` so the panel resolves
 * against the drawer, which is itself `position: fixed` (a guaranteed
 * positioned ancestor) — deterministic regardless of transforms.
 * (Tried `position: fixed` relying on the drawer's `will-change:
 * transform` containing block; WebKit doesn't honor will-change alone
 * for fixed at rest, so the panel dropped to the viewport bottom behind
 * the keyboard.) `bottom` = `drawerBottom - composerTop` from
 * getBoundingClientRect, i.e. the panel's bottom edge sits at the
 * composer's top. `maxHeight` caps the strip to the room above the
 * composer up to the status bar.
 *
 * vaul's drag/`setPointerCapture` is neutralized by `onPointerDown`
 * stopPropagation — React-tree bubbling is unaffected by the DOM portal,
 * so the event still never reaches the Drawer.Content handler. The panel
 * sets `pointer-events: auto` since the drawer subtree is interactive.
 */
export function MentionMobilePanel({
  open,
  anchorRef,
  children,
}: {
  open: boolean;
  /** The composer input the panel docks above (and which stays visible
     as the search field). */
  anchorRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  /* Keep the portal inside the nearest drawer/dialog interaction and scroll
     boundary; use document.body for a normal composer. */
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  /* `bottom` is relative to `container`'s box (the drawer is the
     containing block); `maxHeight` caps the strip. Null until measured
     so we don't flash at the wrong spot. */
  const [metrics, setMetrics] = React.useState<{ bottom: number; maxHeight: number } | null>(null);

  React.useEffect(() => {
    if (!open || typeof document === 'undefined') {
      setContainer(null);
      setMetrics(null);
      return undefined;
    }
    const input = anchorRef.current;
    if (!input || typeof window === 'undefined') return undefined;

    const layer = input.closest<HTMLElement>('[data-vaul-drawer], [data-lody-dialog-content]');
    const target = layer ?? document.body;
    setContainer(target);

    const measure = () => {
      const composerRect = input.getBoundingClientRect();
      /* The positioned modal owns absolute coordinates; the body fallback
         uses fixed viewport coordinates. */
      const layerRect = layer?.getBoundingClientRect();
      const referenceBottom = layerRect?.bottom ?? window.innerHeight;
      const bottom = Math.max(0, referenceBottom - composerRect.top + PANEL_TO_COMPOSER_GAP);
      const maxHeight = Math.min(
        PANEL_MAX_HEIGHT,
        layerRect
          ? Math.max(
              0,
              composerRect.top -
                Math.max(PANEL_TOP_INSET, layerRect.top + PANEL_TO_COMPOSER_GAP) -
                PANEL_TO_COMPOSER_GAP
            )
          : Math.max(120, composerRect.top - PANEL_TOP_INSET)
      );
      setMetrics({ bottom, maxHeight });
    };
    measure();
    const raf1 = requestAnimationFrame(measure);
    const raf2 = requestAnimationFrame(() => requestAnimationFrame(measure));
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('lody:keyboard-resize', measure as EventListener);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    const cleanupResizeObserver = observeResizeOnAnimationFrame(input, () => measure());
    const cleanupLayerObserver = layer ? observeResizeOnAnimationFrame(layer, measure) : undefined;

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('lody:keyboard-resize', measure as EventListener);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
      cleanupResizeObserver();
      cleanupLayerObserver?.();
    };
  }, [open, anchorRef]);

  if (!open || !container) return null;

  /* Absolute inside a positioned modal; fixed for the body fallback. */
  const isInModal = container !== document.body;

  return createPortal(
    /* Single scroll container (see the `.mention-mobile-panel
       .scrollbar-pro` reset in index.css that flattens the menu's inner
       260px scroller into this one — nested scrollers made touch scroll
       flaky). */
    <div
      role="listbox"
      aria-orientation="vertical"
      className={cn(
        'mention-mobile-panel inset-x-2 z-[60] overflow-y-auto overscroll-contain rounded-2xl',
        'border border-border/60 bg-popover text-popover-foreground shadow-xl',
        // Plain fade — never fights vaul's transforms.
        'animate-in fade-in-0 slide-in-from-bottom-2 duration-150'
      )}
      style={{
        position: isInModal ? 'absolute' : 'fixed',
        pointerEvents: 'auto',
        // Momentum scroll on iOS.
        WebkitOverflowScrolling: 'touch',
        bottom: metrics?.bottom ?? 0,
        maxHeight: metrics?.maxHeight ?? 0,
        // Hidden (not unmounted) until measured so the list is ready the
        // instant we know where to put it.
        visibility: metrics == null ? 'hidden' : 'visible',
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      {children}
    </div>,
    container
  );
}
