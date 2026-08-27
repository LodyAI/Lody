import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type FocusEvent as ReactFocusEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Popover, PopoverAnchor, PopoverContent } from '@/ui/popover';
import type { ConversationOutlineEntry } from '@/lib/conversation-outline';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import {
  NO_SCROLL_EDGE_OVERFLOW,
  buildScrollEdgeFadeMask,
  readScrollEdgeOverflow,
  scrollEdgeOverflowEquals,
} from '@/lib/scroll-edge-fade';
import {
  ACTIVE_BAR_OVERHANG,
  ACTIVE_TICK_WIDTH,
  RAIL_EDGE_FADE_LENGTH,
  RAIL_MAX_HEIGHT_RATIO,
  RAIL_SCROLL_PADDING,
  RAIL_TRACK_INSET,
  RAIL_TRACK_WIDTH,
  RAIL_WIDTH,
  TICK_PITCH,
  outlineTickRestingWidth,
  outlineTickWidthAt,
  tickLineTopOffset,
} from './conversation-outline-rail-geometry';

/**
 * A fixed left rail of one tick per conversation round, so a reader can see
 * where they are in a long session and jump between turns. Hovering a tick
 * shows that round's opening words and the agent's opening reply, and magnifies
 * the rail around the cursor — the pointer's own tick extends furthest and its
 * neighbours taper off along a normal distribution, so the tick under the
 * cursor is unmistakable while the rail still reads as one continuous shape.
 *
 * **Where this mounts matters.** It is an absolutely-positioned overlay of the
 * whole conversation page, never a row inside the Virtua list — a row would
 * scroll away. The page-level mount also keeps its centre stable when the
 * composer changes height.
 *
 * **Two rendering rules keep it off the scroll hot path.** The conversation is
 * already a fragile render surface (see this folder's AGENTS.md), so:
 *
 *  1. Reader position never enters the tick list's props, or every tick would
 *     re-render on every scroll event. The active round is painted by a single
 *     absolutely-positioned bar whose `translateY` is pure arithmetic over a
 *     fixed pitch — no measurement, no per-tick state — and `aria-current` is
 *     synced imperatively; see {@link useActiveTickSync}.
 *  2. Magnification DOES flow through props, because it changes every tick at
 *     once. That is affordable where reader position is not: it is driven by
 *     pointer entry (a handful of events as the cursor crosses ticks), not by
 *     scrolling at frame rate. Each tick is memoized on its own width, so a
 *     pointer move only re-renders the few ticks inside the bell.
 */

/**
 * The rail uses a short hover-intent warmup so brushing across ticks does not
 * flash cards, while the Popover's own presence animation supplies the visual
 * transition once the pointer settles.
 */
const HOVER_WARMUP_MS = 200;
const HOVER_WARM_WINDOW_MS = 2_500;

export interface ConversationOutlineRailProps {
  entries: readonly ConversationOutlineEntry[];
  /** Index into `entries`, or -1 when the reader position is unknown. */
  activeIndex: number;
  /** Jump to the round at this index into `entries`. */
  onJumpToRound: (index: number) => void;
  /**
   * The full-page overlay that owns the rail's coordinate system. Omit this
   * for standalone uses such as the component story, where the local pane is
   * the intended coordinate system.
   */
  overlayRoot?: HTMLElement | null;
  className?: string;
}

const OUTLINE_INDEX_ATTRIBUTE = 'data-outline-index';

/** All rail interaction is delegated from the list, so events resolve here. */
const readTickElement = (target: EventTarget | null): HTMLElement | null => {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(`[${OUTLINE_INDEX_ATTRIBUTE}]`);
};

const readTickIndexOf = (tick: HTMLElement | null): number => {
  if (!tick) return -1;
  const parsed = Number(tick.getAttribute(OUTLINE_INDEX_ATTRIBUTE));
  return Number.isInteger(parsed) ? parsed : -1;
};

const readTickIndex = (target: EventTarget | null): number =>
  readTickIndexOf(readTickElement(target));

/**
 * Point `aria-current` at the round the reader is in, without re-rendering the
 * tick list. React owns every other attribute on these buttons, so this has to
 * re-run after any commit that re-creates them — hence the dependency on the
 * tick list's own inputs, not just on `activeIndex`.
 */
function useActiveTickSync(
  containerRef: React.RefObject<HTMLOListElement | null>,
  activeIndex: number,
  /** The tick list's own input — re-run whenever a commit re-created the buttons. */
  entries: readonly ConversationOutlineEntry[]
): void {
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const previous = container.querySelector('[aria-current="true"]');
    if (previous) previous.removeAttribute('aria-current');
    if (activeIndex < 0) return;
    const next = container.querySelector(`[${OUTLINE_INDEX_ATTRIBUTE}="${activeIndex}"]`);
    next?.setAttribute('aria-current', 'true');
  }, [activeIndex, containerRef, entries]);
}

/**
 * One tick, memoized on its resolved width. As the pointer moves by one tick,
 * only the handful inside the magnification bell change width; every other tick
 * bails out of this compare rather than re-rendering.
 */
const OutlineTick = memo(function OutlineTick({
  index,
  width,
  tabbable,
  label,
}: {
  index: number;
  width: number;
  tabbable: boolean;
  label: string;
}) {
  return (
    <li className="contents">
      <button
        type="button"
        {...{ [OUTLINE_INDEX_ATTRIBUTE]: index }}
        tabIndex={tabbable ? 0 : -1}
        aria-label={label}
        // The hit area spans the whole track and one full pitch of height; only
        // the inner line is visible. Focus shows on the line (via the group),
        // never as a ring around the invisible hit box.
        className="group/tick flex w-full items-center outline-hidden"
        style={{ height: TICK_PITCH }}
      >
        <span
          aria-hidden="true"
          style={{ width }}
          className={cn(
            // Resting contrast has to carry the edge fade: at /25 the ticks
            // were faint enough that a gradient over them had almost nothing
            // to take away, so a scrollable edge looked the same as a hard one.
            'h-[2px] rounded-full bg-muted-foreground/45',
            // Ease-out so the swell tracks the cursor immediately and settles,
            // rather than lagging behind it.
            'transition-[background-color,width] duration-150 ease-out',
            'group-hover/tick:bg-muted-foreground/80',
            'group-focus-visible/tick:bg-foreground/80'
          )}
        />
      </button>
    </li>
  );
});

const OutlineTickList = memo(function OutlineTickList({
  entries,
  tabbableIndex,
  magnifiedIndex,
  jumpLabel,
}: {
  entries: readonly ConversationOutlineEntry[];
  tabbableIndex: number;
  /** Tick under the pointer, or -1 when the pointer is off the rail. */
  magnifiedIndex: number;
  jumpLabel: (entry: ConversationOutlineEntry) => string;
}) {
  return (
    <>
      {entries.map((entry, index) => (
        <OutlineTick
          key={entry.key}
          index={index}
          width={outlineTickWidthAt(outlineTickRestingWidth(entry.weight), index, magnifiedIndex)}
          tabbable={index === tabbableIndex}
          label={jumpLabel(entry)}
        />
      ))}
    </>
  );
});

export function ConversationOutlineRail({
  entries,
  activeIndex,
  onJumpToRound,
  overlayRoot = null,
  className,
}: ConversationOutlineRailProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLOListElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tabbableIndex, setTabbableIndex] = useState(0);
  /**
   * Tick under the pointer RIGHT NOW. Drives magnification, so it updates the
   * moment the cursor crosses into a tick — unlike {@link hoverCard}, which
   * waits out the warmup so brushing past the rail does not flash a card.
   */
  const [pointerIndex, setPointerIndex] = useState(-1);
  /** One state, because the index and its anchor are never meaningful apart. */
  const [hoverCard, setHoverCard] = useState<{ index: number; element: HTMLElement } | null>(null);
  /** Separate visibility from content so the close animation never fades an empty card. */
  const [cardOpen, setCardOpen] = useState(false);

  const activeIndexRef = useLatestRef(activeIndex);

  const jumpLabel = useCallback(
    (entry: ConversationOutlineEntry) =>
      entry.title || t('sessions.outline.untitledRound', 'Untitled turn'),
    [t]
  );

  useActiveTickSync(listRef, activeIndex, entries);

  // Keep the active tick inside the strip when the rail itself has to scroll.
  // Computed from the fixed pitch rather than `scrollIntoView` so the
  // conversation's scroll handler never triggers a forced layout here.
  useEffect(() => {
    const strip = scrollRef.current;
    if (!strip || activeIndex < 0) return;
    const viewport = strip.clientHeight;
    if (strip.scrollHeight <= viewport) return;
    const lineTop = RAIL_SCROLL_PADDING + tickLineTopOffset(activeIndex);
    const target = lineTop - viewport / 2;
    const clamped = Math.max(0, Math.min(target, strip.scrollHeight - viewport));
    if (Math.abs(strip.scrollTop - clamped) > 1) {
      strip.scrollTop = clamped;
    }
  }, [activeIndex]);

  // Which edges have ticks beyond them, so the strip can fade there. Assigning
  // `scrollTop` above fires a scroll event, so the handler below covers the
  // auto-centring too; this effect only has to catch mount and content changes.
  const [edgeOverflow, setEdgeOverflow] = useState(NO_SCROLL_EDGE_OVERFLOW);
  const syncEdgeFade = useCallback(() => {
    const strip = scrollRef.current;
    if (!strip) return;
    const next = readScrollEdgeOverflow(strip);
    setEdgeOverflow((current) => (scrollEdgeOverflowEquals(current, next) ? current : next));
  }, []);

  // Only the tick COUNT can change which edges overflow, and `entries` takes a
  // new identity for every delta that grows a preview — so keying this on the
  // array would tear down the observer and re-measure at token rate.
  const tickCount = entries.length;
  useEffect(() => {
    syncEdgeFade();
    const strip = scrollRef.current;
    if (!strip) return undefined;
    // The pane resizing changes what fits, and therefore which edges overflow.
    return observeResizeOnAnimationFrame(strip, syncEdgeFade);
  }, [syncEdgeFade, tickCount]);

  const cardOpenRef = useLatestRef(cardOpen);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClosedAtRef = useRef(0);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current === null) return;
    clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);

  useEffect(() => clearOpenTimer, [clearOpenTimer]);

  const handlePointerOver = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // Touch has no hover; a tap should jump, not open a card it cannot dismiss.
      if (event.pointerType === 'touch') return;
      const element = readTickElement(event.target);
      const index = readTickIndexOf(element);
      if (!element || index === -1) return;

      // Magnify immediately — this is direct manipulation and must not wait on
      // the card's warmup, or the rail would feel unresponsive to the cursor.
      setPointerIndex(index);
      clearOpenTimer();
      const isWarm =
        cardOpenRef.current || Date.now() - lastClosedAtRef.current < HOVER_WARM_WINDOW_MS;
      if (isWarm) {
        setHoverCard({ index, element });
        setCardOpen(true);
        return;
      }
      openTimerRef.current = setTimeout(() => {
        openTimerRef.current = null;
        setHoverCard({ index, element });
        setCardOpen(true);
      }, HOVER_WARMUP_MS);
    },
    [cardOpenRef, clearOpenTimer]
  );

  const handlePointerLeave = useCallback(() => {
    // The swell collapses with the cursor. The card content stays in state until
    // Radix finishes its own close animation, so the animation never fades an
    // empty surface.
    setPointerIndex(-1);
    clearOpenTimer();
    if (cardOpenRef.current) lastClosedAtRef.current = Date.now();
    setCardOpen(false);
  }, [cardOpenRef, clearOpenTimer]);

  // Depends on the COUNT, not the array: the outline gets a new identity per
  // streamed delta, and this callback feeds the list's click/key handlers.
  const jumpTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= tickCount) return;
      setTabbableIndex(index);
      onJumpToRound(index);
    },
    [onJumpToRound, tickCount]
  );

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const index = readTickIndex(event.target);
      if (index === -1) return;
      clearOpenTimer();
      if (cardOpenRef.current) lastClosedAtRef.current = Date.now();
      setCardOpen(false);
      jumpTo(index);
    },
    [cardOpenRef, clearOpenTimer, jumpTo]
  );

  const focusTick = useCallback((index: number) => {
    const container = listRef.current;
    if (!container) return;
    const tick = container.querySelector<HTMLElement>(`[${OUTLINE_INDEX_ATTRIBUTE}="${index}"]`);
    tick?.focus();
  }, []);

  /**
   * Tab lands on the round the reader is actually in rather than always on the
   * first one. Reads the active index from a ref so this costs no subscription.
   */
  const handleFocus = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => {
      const index = readTickIndex(event.target);
      if (index === -1) return;
      const active = activeIndexRef.current;
      if (index === 0 && active > 0 && !event.currentTarget.contains(event.relatedTarget)) {
        setTabbableIndex(active);
        focusTick(active);
        return;
      }
      setTabbableIndex(index);
    },
    [activeIndexRef, focusTick]
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const index = readTickIndex(event.target);
      if (index === -1) return;

      let nextIndex = -1;
      if (event.key === 'ArrowDown') nextIndex = Math.min(index + 1, tickCount - 1);
      else if (event.key === 'ArrowUp') nextIndex = Math.max(index - 1, 0);
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tickCount - 1;

      if (nextIndex !== -1) {
        event.preventDefault();
        setTabbableIndex(nextIndex);
        focusTick(nextIndex);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        jumpTo(index);
      }
    },
    [focusTick, jumpTo, tickCount]
  );

  const hoveredEntry = hoverCard ? (entries[hoverCard.index] ?? null) : null;
  const contentHeight = tickCount * TICK_PITCH;
  const edgeMask = buildScrollEdgeFadeMask(edgeOverflow, RAIL_EDGE_FADE_LENGTH);
  const activeBarTop = activeIndex < 0 ? 0 : tickLineTopOffset(activeIndex);
  // The active bar rides the same bell as the ticks, so magnifying the round
  // the reader is in extends the bright bar too instead of leaving a dim tick
  // growing out from under a fixed-width highlight. `max` keeps its resting
  // presence: a light round's tick is short, but its bar still reads as the
  // widest thing on the rail when nothing is magnified.
  const activeEntry = activeIndex < 0 ? undefined : entries[activeIndex];
  const activeBarWidth =
    activeEntry === undefined
      ? ACTIVE_TICK_WIDTH
      : Math.max(
          ACTIVE_TICK_WIDTH,
          outlineTickWidthAt(
            outlineTickRestingWidth(activeEntry.weight),
            activeIndex,
            pointerIndex
          ) + ACTIVE_BAR_OVERHANG
        );

  if (tickCount < 2) return null;

  const rail = (
    <nav
      aria-label={t('sessions.outline.railLabel', 'Conversation outline')}
      // Low contrast at rest so the rail reads as a margin marker, not chrome;
      // the whole strip lifts together on hover so a single tick never has to
      // be found before it becomes visible.
      className={cn(
        'group/rail pointer-events-none absolute inset-y-0 left-0 z-10 hidden items-center',
        // The conversation column is 46rem wide and centered. Below this the
        // rail would sit on top of message content, so it does not render at
        // all. A container query keeps that decision in CSS — no JS
        // measurement, no layout shift on mount.
        '@[860px]:flex',
        className
      )}
      style={{ width: RAIL_WIDTH }}
    >
      <div
        ref={scrollRef}
        onScroll={syncEdgeFade}
        className="pointer-events-auto overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{
          // Capped rather than full-height: a long session otherwise runs the
          // ticks edge to edge and the rail reads as page chrome instead of a
          // margin marker. Past the cap the strip scrolls and keeps the active
          // round centred.
          maxHeight: `${RAIL_MAX_HEIGHT_RATIO * 100}%`,
          paddingBlock: RAIL_SCROLL_PADDING,
          paddingLeft: RAIL_TRACK_INSET,
          // Fades only the edge that actually has ticks past it, so the rail
          // stops on a hard crop exactly when there is nothing more to reach.
          maskImage: edgeMask,
          WebkitMaskImage: edgeMask,
        }}
      >
        {/* The track is wide enough for a fully magnified tick. It has to be:
            `overflow-y: auto` makes the x axis `auto` too, so a tick wider than
            this would scroll the rail sideways instead of just extending.
            The list also stays IN FLOW — an absolutely-positioned list would
            leave this box with nothing to size from, collapsing every tick to
            zero width. Only the active bar is taken out of flow. */}
        <div className="relative" style={{ width: RAIL_TRACK_WIDTH, height: contentHeight }}>
          <ol
            ref={listRef}
            className="m-0 flex list-none flex-col p-0"
            onPointerOver={handlePointerOver}
            onPointerLeave={handlePointerLeave}
            onClick={handleClick}
            onFocus={handleFocus}
            onKeyDown={handleKeyDown}
          >
            <OutlineTickList
              entries={entries}
              tabbableIndex={tabbableIndex}
              magnifiedIndex={pointerIndex}
              jumpLabel={jumpLabel}
            />
          </ol>
          {activeIndex < 0 ? null : (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 h-[2px] rounded-full bg-foreground/80 transition-[transform,width] duration-150 ease-out"
              style={{
                width: activeBarWidth,
                transform: `translateY(${activeBarTop}px)`,
              }}
            />
          )}
        </div>
      </div>

      {/* ONE popover for the whole rail, re-anchored to the hovered tick. A
          popover per tick would mount hundreds of Radix instances for a long
          session. */}
      <Popover open={cardOpen && hoveredEntry !== null}>
        <PopoverAnchor virtualRef={hoverCard ? { current: hoverCard.element } : undefined} />
        <PopoverContent
          side="right"
          align="center"
          sideOffset={10}
          // Purely informational: it must never take focus from the rail, and
          // dismissing it is the pointer's job.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="pointer-events-none w-72 select-none p-3"
          onAnimationEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.currentTarget.dataset.state === 'closed' &&
              !cardOpenRef.current
            ) {
              setHoverCard(null);
            }
          }}
        >
          {hoveredEntry === null ? null : (
            <>
              <div className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
                {jumpLabel(hoveredEntry)}
              </div>
              <div className="mt-1.5 line-clamp-4 text-[12px] leading-relaxed text-muted-foreground">
                {hoveredEntry.preview ||
                  (hoveredEntry.startsWithAgent
                    ? t('sessions.outline.noUserMessage', 'Started by the agent.')
                    : t('sessions.outline.noReplyYet', 'No reply yet.'))}
              </div>
            </>
          )}
        </PopoverContent>
      </Popover>
    </nav>
  );

  return overlayRoot === null ? rail : createPortal(rail, overlayRoot);
}

export default ConversationOutlineRail;
