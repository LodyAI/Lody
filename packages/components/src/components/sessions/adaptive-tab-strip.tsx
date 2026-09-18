import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';

export const ACTIVE_TAB_MIN_WIDTH = 180;

export type AdaptiveTabStripItemLayout = {
  id: string;
  width: number;
  marginRight: number;
  marginInlineStart?: number;
};

export type AdaptiveTabStripLayout = {
  paddingLeft: number;
  paddingRight: number;
  items: AdaptiveTabStripItemLayout[];
};

export type AllocateAdaptiveTabStripLayoutOptions = {
  viewportWidth: number;
  itemIds: readonly string[];
  activeItemId: string | null;
  gap: number;
  paddingLeft: number;
  paddingRight: number;
  activeMinWidth: number;
};

const toNonNegativeInteger = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

function distributeEvenly(totalWidth: number, itemCount: number): number[] {
  if (itemCount <= 0) return [];

  const baseWidth = Math.floor(totalWidth / itemCount);
  let remainder = totalWidth - baseWidth * itemCount;

  return Array.from({ length: itemCount }, () => baseWidth + (remainder-- > 0 ? 1 : 0));
}

export function allocateAdaptiveTabStripLayout({
  viewportWidth,
  itemIds,
  activeItemId,
  gap,
  paddingLeft,
  paddingRight,
  activeMinWidth,
}: AllocateAdaptiveTabStripLayoutOptions): AdaptiveTabStripLayout {
  const width = toNonNegativeInteger(viewportWidth);
  const effectivePaddingLeft = Math.min(toNonNegativeInteger(paddingLeft), width);
  const effectivePaddingRight = Math.min(
    toNonNegativeInteger(paddingRight),
    width - effectivePaddingLeft
  );
  const contentWidth = width - effectivePaddingLeft - effectivePaddingRight;
  const gapCount = Math.max(0, itemIds.length - 1);
  const effectiveGap =
    gapCount === 0 ? 0 : Math.min(toNonNegativeInteger(gap), Math.floor(contentWidth / gapCount));
  const itemWidthBudget = contentWidth - effectiveGap * gapCount;

  if (itemIds.length === 0) {
    return {
      paddingLeft: effectivePaddingLeft,
      paddingRight: effectivePaddingRight,
      items: [],
    };
  }

  const activeIndex = activeItemId === null ? -1 : itemIds.indexOf(activeItemId);
  let itemWidths: number[];

  const minimumActiveWidth = toNonNegativeInteger(activeMinWidth);
  const allTabsFitMinimum = itemWidthBudget >= minimumActiveWidth * itemIds.length;

  if (itemIds.length === 1 || activeIndex === -1 || allTabsFitMinimum) {
    itemWidths = distributeEvenly(itemWidthBudget, itemIds.length);
  } else {
    const activeWidth = Math.min(minimumActiveWidth, itemWidthBudget);
    const inactiveWidths = distributeEvenly(itemWidthBudget - activeWidth, itemIds.length - 1);
    let inactiveIndex = 0;

    itemWidths = itemIds.map((_, index) =>
      index === activeIndex ? activeWidth : inactiveWidths[inactiveIndex++]!
    );
  }

  return {
    paddingLeft: effectivePaddingLeft,
    paddingRight: effectivePaddingRight,
    items: itemIds.map((id, index) => ({
      id,
      width: itemWidths[index]!,
      marginRight: index === itemIds.length - 1 ? 0 : effectiveGap,
    })),
  };
}

/* Chrome's rapid-close mode (Chromium `in_tab_close_` /
   `override_available_width_for_tabs_`): while the pointer stays over the tab
   strip, removing a tab keeps every surviving tab at its current width instead
   of re-expanding to fill the row, so the next tab's close button lands under
   the cursor and repeated clicks keep closing tabs. Widths freeze by ROLE, not
   by id: Chromium promotes the newly active tab to the active width, so a tab
   that becomes active mid-freeze takes the captured active width while the
   deselected one drops back to an inactive width.

   The freeze releases when the pointer leaves an EXPANDED region — Chromium's
   MouseWatcher watches the strip grown by 40px downward and 60px toward the
   new-tab button so drifting toward `+` does not re-expand mid-gesture. It also
   releases when a tab is added, the viewport shrinks below the captured width
   (Chromium caps the override at the real width but keeps it when the strip
   grows), or a single tab remains (Chromium exits close mode outright).

   Removing the LAST tab is the exception: Chromium does not shrink the frozen
   budget for it, so survivors re-expand over the already-shrunk budget and the
   new last tab's right edge — hence its close button — stays under the cursor.
   Unfrozen, that reduces to a normal full-width relayout; while frozen, the
   strip re-spreads survivors over the previously occupied width.

   Removals and inserts are animated like Chromium's BoundsAnimator (200ms):
   the survivor sliding into a removed slot starts with a margin-inline-start
   equal to the freed space and eases it to zero, and an inserted tab grows
   from zero width to its allocated width. */
const CLOSE_MODE_EXIT_SLOP_BOTTOM = 40;
const CLOSE_MODE_EXIT_SLOP_TRAILING = 60;

const EMPTY_MARGIN_MAP: ReadonlyMap<string, number> = new Map();

/* The freeze only arms on a real pointer gesture inside the strip — Chromium
   enters close mode solely for CloseTabSource::kFromMouse/kFromTouch, so a
   keyboard or programmatic close while the pointer happens to hover the strip
   must not freeze widths. A click delivers the removal within milliseconds,
   so a short arming window is plenty. */
const CLOSE_ARM_WINDOW_MS = 1500;

/* Chromium keeps the frozen budget untouched when the LAST tab is removed
   (`model_index >= last_visible_tab_index` skips the shrink), so the survivors
   re-spread over the width the strip already occupied and the new last tab's
   right edge — hence its close button — stays under the cursor. */
function spreadFrozenTabStripLayout(
  frozen: FrozenTabStripLayout,
  previousLayout: AdaptiveTabStripLayout,
  itemIds: readonly string[],
  activeItemId: string | null,
  activeMinWidth: number
): FrozenTabStripLayout {
  const occupied =
    previousLayout.paddingLeft +
    previousLayout.paddingRight +
    previousLayout.items.reduce((sum, item) => sum + item.width + item.marginRight, 0);
  const spread = allocateAdaptiveTabStripLayout({
    viewportWidth: occupied,
    itemIds,
    activeItemId,
    gap: frozen.gap,
    paddingLeft: frozen.paddingLeft,
    paddingRight: frozen.paddingRight,
    activeMinWidth,
  });
  return freezeTabStripLayout(spread, frozen.viewportWidth, activeItemId);
}

type FrozenTabStripLayout = {
  viewportWidth: number;
  paddingLeft: number;
  paddingRight: number;
  gap: number;
  widthById: ReadonlyMap<string, number>;
  activeItemId: string | null;
  activeWidth: number;
  inactiveWidth: number;
};

function retainFrozenTabStripLayout(
  frozen: FrozenTabStripLayout,
  itemIds: readonly string[],
  activeItemId: string | null
): AdaptiveTabStripLayout {
  return {
    paddingLeft: frozen.paddingLeft,
    paddingRight: frozen.paddingRight,
    items: itemIds.map((id, index) => ({
      id,
      width:
        frozen.activeWidth > 0 && id === activeItemId
          ? frozen.activeWidth
          : id === frozen.activeItemId
            ? frozen.inactiveWidth
            : (frozen.widthById.get(id) ?? 0),
      marginRight: index === itemIds.length - 1 ? 0 : frozen.gap,
    })),
  };
}

function freezeTabStripLayout(
  layout: AdaptiveTabStripLayout,
  viewportWidth: number,
  activeItemId: string | null
): FrozenTabStripLayout {
  const widthById = new Map(layout.items.map((item) => [item.id, item.width]));
  return {
    viewportWidth,
    paddingLeft: layout.paddingLeft,
    paddingRight: layout.paddingRight,
    gap: layout.items.length > 1 ? layout.items[0].marginRight : 0,
    widthById,
    activeItemId,
    activeWidth: activeItemId === null ? 0 : (widthById.get(activeItemId) ?? 0),
    inactiveWidth: layout.items.find((item) => item.id !== activeItemId)?.width ?? 0,
  };
}

type AdaptiveTabStripContextValue = {
  itemLayoutById: ReadonlyMap<string, AdaptiveTabStripItemLayout> | null;
  fallbackMarginById: ReadonlyMap<string, number>;
};

const AdaptiveTabStripContext = createContext<AdaptiveTabStripContextValue | null>(null);

export type AdaptiveTabStripProps = Omit<ComponentPropsWithoutRef<'div'>, 'children'> & {
  itemIds: readonly string[];
  activeItemId: string | null;
  children: ReactNode;
  viewportClassName?: string;
  gap?: number;
  paddingLeft?: number;
  paddingRight?: number;
  activeMinWidth?: number;
};

export function AdaptiveTabStrip({
  itemIds,
  activeItemId,
  children,
  viewportClassName,
  gap = 6,
  paddingLeft = 8,
  paddingRight = 8,
  activeMinWidth = ACTIVE_TAB_MIN_WIDTH,
  className,
  style,
  ...props
}: AdaptiveTabStripProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  const armedAtRef = useRef<number | null>(null);
  const [frozenLayout, setFrozenLayout] = useState<FrozenTabStripLayout | null>(null);
  const [slideMargins, setSlideMargins] = useState<ReadonlyMap<string, number>>(EMPTY_MARGIN_MAP);
  const [enteringWidths, setEnteringWidths] =
    useState<ReadonlyMap<string, number>>(EMPTY_MARGIN_MAP);
  const [renderedItemIds, setRenderedItemIds] = useState(itemIds);
  const [renderedActiveItemId, setRenderedActiveItemId] = useState(activeItemId);
  const [renderedViewportWidth, setRenderedViewportWidth] = useState(viewportWidth);
  const appliedLayoutRef = useRef<AdaptiveTabStripLayout | null>(null);
  const appliedViewportWidthRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    const measure = () => {
      const nextWidth = viewport.clientWidth;
      setViewportWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
    };

    measure();
    return observeResizeOnAnimationFrame(viewport, measure);
  }, []);

  const layout = useMemo(() => {
    if (viewportWidth === null) return null;
    if (
      frozenLayout !== null &&
      viewportWidth >= frozenLayout.viewportWidth &&
      itemIds.every((id) => frozenLayout.widthById.has(id))
    ) {
      return retainFrozenTabStripLayout(frozenLayout, itemIds, activeItemId);
    }
    return allocateAdaptiveTabStripLayout({
      viewportWidth,
      itemIds,
      activeItemId,
      gap,
      paddingLeft,
      paddingRight,
      activeMinWidth,
    });
  }, [
    activeItemId,
    activeMinWidth,
    frozenLayout,
    gap,
    itemIds,
    paddingLeft,
    paddingRight,
    viewportWidth,
  ]);

  // Snapshot the committed geometry so the NEXT render's diff reads the
  // previous commit's layout and viewport.
  useLayoutEffect(() => {
    appliedLayoutRef.current = layout;
    appliedViewportWidthRef.current = viewportWidth;
  }, [layout, viewportWidth]);

  // Removals, selection changes, and viewport changes are decided DURING
  // RENDER — React's derived-state adjustment pattern. A removal commit's very
  // first render already calls setFrozenLayout, so React discards that output
  // and commits only the frozen result: the unfrozen allocation never reaches
  // the DOM. Deciding in an effect let that first allocation paint (or seed a
  // transition's starting width), which flashed survivors at the fresh width
  // for a frame before the freeze landed.
  if (
    renderedItemIds !== itemIds ||
    renderedActiveItemId !== activeItemId ||
    renderedViewportWidth !== viewportWidth
  ) {
    const previousItemIds = renderedItemIds;
    const previousActiveItemId = renderedActiveItemId;
    const previousLayout = appliedLayoutRef.current;
    const previousViewportWidth = appliedViewportWidthRef.current;
    setRenderedItemIds(itemIds);
    setRenderedActiveItemId(activeItemId);
    setRenderedViewportWidth(viewportWidth);

    const currentIds = new Set(itemIds);
    const previousIds = new Set(previousItemIds);
    const removedIds = previousItemIds.filter((id) => !currentIds.has(id));
    const addedIds = itemIds.filter((id) => !previousIds.has(id));
    const geometryStable =
      previousLayout !== null && viewportWidth !== null && previousViewportWidth === viewportWidth;

    // Chromium animates EVERY removal through StartRemoveTabAnimation: the
    // survivor moving into a freed slot starts with a margin-inline-start
    // equal to the freed space and eases it to zero, which reads as the gap
    // collapsing under the tabs that follow. Inserts grow from zero width the
    // same way (StartInsertTabAnimation). The survivor promoted to ACTIVE is
    // the exception: it also transitions to the captured active width, and
    // sliding + widening together reads as the tab unfolding out of the empty
    // slot from zero — Chromium hides this by shrinking the closed tab inside
    // the gap, which our approximation cannot do — so the promoted tab grows
    // into the slot's width in place instead.
    if (geometryStable && removedIds.length > 0) {
      const spaceById = new Map(
        previousLayout.items.map((item) => [item.id, item.width + item.marginRight])
      );
      // Direct state values, not updater functions: render-phase updates run
      // under StrictMode's double render, and an updater that adds to the
      // queued margin would compound on the second invocation.
      const nextMargins = new Map(slideMargins);
      nextMargins.forEach((_, id) => {
        if (!currentIds.has(id)) nextMargins.delete(id);
      });
      for (const removedId of removedIds) {
        const removedIndex = previousItemIds.indexOf(removedId);
        const survivorId = previousItemIds.slice(removedIndex + 1).find((id) => currentIds.has(id));
        if (survivorId === undefined || survivorId === activeItemId) continue;
        nextMargins.set(
          survivorId,
          (nextMargins.get(survivorId) ?? 0) + (spaceById.get(removedId) ?? 0)
        );
      }
      setSlideMargins(nextMargins);
    }
    // When the active selection lands in a LATER commit (the real app removes
    // first, then navigates), an already-sliding promoted tab drops its slide
    // so it widens in place rather than unfolding.
    if (
      activeItemId !== null &&
      activeItemId !== previousActiveItemId &&
      slideMargins.has(activeItemId)
    ) {
      const nextMargins = new Map(slideMargins);
      nextMargins.delete(activeItemId);
      setSlideMargins(nextMargins);
    }
    // Grow-in only when the strip was already populated — a lone tab appearing
    // in an empty strip should not look like it materializes. A PURE insert
    // grows from zero like Chromium's StartInsertTabAnimation; a commit that
    // removes AND adds is a substitution (a draft promoting to a session, or an
    // auto-created draft replacing a closed tab), so the replacement morphs
    // from the nearest removed item's width instead of appearing from nothing.
    if (geometryStable && addedIds.length > 0 && previousItemIds.length > 0) {
      const widthByRemoved = new Map(previousLayout.items.map((item) => [item.id, item.width]));
      const addedIndexById = new Map(itemIds.map((id, index) => [id, index]));
      const nextWidths = new Map(enteringWidths);
      nextWidths.forEach((_, id) => {
        if (!currentIds.has(id)) nextWidths.delete(id);
      });
      for (const addedId of addedIds) {
        let fromWidth = 0;
        if (removedIds.length > 0) {
          const addedIndex = addedIndexById.get(addedId) ?? 0;
          let distance = Number.POSITIVE_INFINITY;
          for (const removedId of removedIds) {
            const offset = Math.abs(previousItemIds.indexOf(removedId) - addedIndex);
            if (offset < distance) {
              distance = offset;
              fromWidth = widthByRemoved.get(removedId) ?? 0;
            }
          }
        }
        nextWidths.set(addedId, fromWidth);
      }
      setEnteringWidths(nextWidths);
    }

    if (frozenLayout !== null) {
      // The freeze becomes stale when the viewport shrinks below the captured
      // width (Chromium caps the override at the real width but keeps it when
      // the strip grows), an unknown item appears, or a single tab remains —
      // Chromium exits close mode outright once one visible tab is left.
      const stale =
        itemIds.length <= 1 ||
        (viewportWidth !== null && viewportWidth < frozenLayout.viewportWidth) ||
        itemIds.some((id) => !frozenLayout.widthById.has(id));
      if (stale) {
        setFrozenLayout(null);
      } else {
        // Chromium does not shrink the frozen budget when the trailing tab is
        // removed: the survivors re-spread over the space they already
        // occupied, so the new last tab's right edge — and its close button —
        // stays under the cursor.
        const previousLastId = previousItemIds[previousItemIds.length - 1];
        if (
          previousLayout !== null &&
          itemIds.length > 0 &&
          removedIds.length === 1 &&
          removedIds[0] === previousLastId
        ) {
          setFrozenLayout(
            spreadFrozenTabStripLayout(
              frozenLayout,
              previousLayout,
              itemIds,
              activeItemId,
              activeMinWidth
            )
          );
        }
      }
    } else if (
      geometryStable &&
      removedIds.length > 0 &&
      addedIds.length === 0 &&
      itemIds.length > 1 &&
      armedAtRef.current !== null &&
      performance.now() - armedAtRef.current <= CLOSE_ARM_WINDOW_MS &&
      !(removedIds.length === 1 && removedIds[0] === previousItemIds[previousItemIds.length - 1])
    ) {
      // The previous active item — not the current prop — owns the frozen
      // active width: closing the active tab delivers the removal and the new
      // selection in the same commit, and the layout it is frozen from still
      // shows the old active tab.
      setFrozenLayout(freezeTabStripLayout(previousLayout, viewportWidth, previousActiveItemId));
    }
  }

  // Chromium exits close mode when the pointer leaves a MouseWatcher region
  // EXPANDED past the strip: 40px downward and 60px toward the new-tab button,
  // so drifting toward `+` or slightly below the strip does not re-expand the
  // tabs mid-gesture.
  useEffect(() => {
    if (frozenLayout === null) return undefined;
    const onPointerMove = (event: PointerEvent) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const rtl = getComputedStyle(viewport).direction === 'rtl';
      const withinX = rtl
        ? event.clientX >= rect.left - CLOSE_MODE_EXIT_SLOP_TRAILING && event.clientX <= rect.right
        : event.clientX >= rect.left && event.clientX <= rect.right + CLOSE_MODE_EXIT_SLOP_TRAILING;
      const withinY =
        event.clientY >= rect.top && event.clientY <= rect.bottom + CLOSE_MODE_EXIT_SLOP_BOTTOM;
      if (!withinX || !withinY) setFrozenLayout(null);
    };
    window.addEventListener('pointermove', onPointerMove, true);
    return () => window.removeEventListener('pointermove', onPointerMove, true);
  }, [frozenLayout]);

  // One frame after slide margins / entering widths are applied they retarget
  // to their resting values, so the CSS transition plays the collapse/grow-in.
  useEffect(() => {
    if (slideMargins.size === 0 && enteringWidths.size === 0) return undefined;
    const retarget = () => {
      // Missing margins render as zero; empty state also stops frame scheduling.
      setSlideMargins(EMPTY_MARGIN_MAP);
      setEnteringWidths(EMPTY_MARGIN_MAP);
    };
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(retarget);
      return () => cancelAnimationFrame(frame);
    }
    const timeout = setTimeout(retarget, 0);
    return () => clearTimeout(timeout);
  }, [slideMargins, enteringWidths]);

  const contextValue = useMemo<AdaptiveTabStripContextValue>(() => {
    const fallbackMarginById = new Map<string, number>();
    itemIds.forEach((id, index) => {
      fallbackMarginById.set(id, index === itemIds.length - 1 ? 0 : gap);
    });

    return {
      itemLayoutById:
        layout === null
          ? null
          : new Map(
              layout.items.map((item) => [
                item.id,
                {
                  ...item,
                  width: enteringWidths.get(item.id) ?? item.width,
                  marginInlineStart: slideMargins.get(item.id) ?? 0,
                },
              ])
            ),
      fallbackMarginById,
    };
  }, [enteringWidths, gap, itemIds, layout, slideMargins]);

  // The viewport is the flex remainder after the surrounding fixed controls.
  // Integer widths and margins replace Radix's max-content table wrapper, which
  // made equal flex children wider than the visible tab area.
  return (
    <div
      ref={viewportRef}
      className={cn('min-w-0 flex-1 overflow-hidden', viewportClassName)}
      data-adaptive-tab-strip-viewport=""
      onPointerDown={() => {
        // Chromium only enters rapid-close mode for a pointer-triggered close:
        // arm the gesture here so a keyboard/programmatic removal cannot freeze
        // the strip just because the pointer happens to be hovering over it.
        armedAtRef.current = performance.now();
      }}
    >
      <AdaptiveTabStripContext.Provider value={contextValue}>
        <div
          {...props}
          className={cn('flex w-full items-center', className)}
          style={
            {
              ...style,
              boxSizing: 'border-box',
              paddingLeft: layout?.paddingLeft ?? paddingLeft,
              paddingRight: layout?.paddingRight ?? paddingRight,
            } as CSSProperties
          }
          data-adaptive-tab-strip=""
        >
          {children}
        </div>
      </AdaptiveTabStripContext.Provider>
    </div>
  );
}

export type AdaptiveTabStripItemProps = ComponentPropsWithoutRef<'div'> & {
  itemId: string;
};

export const AdaptiveTabStripItem = forwardRef<HTMLDivElement, AdaptiveTabStripItemProps>(
  function AdaptiveTabStripItem({ itemId, className, style, ...props }, ref) {
    const context = useContext(AdaptiveTabStripContext);
    if (!context) {
      throw new Error('AdaptiveTabStripItem must be rendered inside AdaptiveTabStrip');
    }

    const itemLayout = context.itemLayoutById?.get(itemId);
    const layoutStyle: CSSProperties = itemLayout
      ? {
          flex: '0 0 auto',
          width: itemLayout.width,
          marginRight: itemLayout.marginRight,
          marginInlineStart: itemLayout.marginInlineStart ?? 0,
        }
      : {
          flex: '1 1 0',
          marginRight: context.fallbackMarginById.get(itemId) ?? 0,
        };

    // margin-inline-start plays the removal slide; width plays the insert
    // grow-in and the release re-expansion. Reduced-motion users get the same
    // resting geometry without the animation.
    return (
      <div
        {...props}
        ref={ref}
        className={cn(
          'min-w-0 overflow-hidden transition-[width,margin-inline-start] duration-200 motion-reduce:transition-none',
          className
        )}
        style={{ ...style, ...layoutStyle }}
        data-adaptive-tab-strip-item={itemId}
      />
    );
  }
);
