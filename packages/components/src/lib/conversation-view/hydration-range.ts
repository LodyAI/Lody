export type TurnRange = { from: number; to: number };

/** Turns hydrated before any scroll position is known: the conversation opens at its tail. */
export const TAIL_HYDRATION_WINDOW = 30;
/** Floor on prefetch so a viewport showing one giant turn still warms its neighbours. */
export const MIN_PREFETCH_TURNS = 8;
/** Prefetch this many visible-window spans above and below the viewport. */
export const PREFETCH_SCREENS = 2;
/**
 * Ranges snap to this many turns so a scroll that shifts the viewport by one
 * turn does not re-issue `ensureRange` and re-render the stream every event.
 */
export const HYDRATION_RANGE_QUANTUM = 8;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/**
 * The `[from, to)` window of turns the renderer keeps hydrated for a visible
 * `[from, to)` window: the viewport plus `PREFETCH_SCREENS` viewports of
 * turns on each side, snapped to `HYDRATION_RANGE_QUANTUM`. Without a
 * visible window yet (before the initial scroll restore) it is the tail.
 */
export function computeHydrationRange(
  visible: TurnRange | null,
  turnCount: number,
  options: { tailWindow?: number; minPrefetch?: number; screens?: number; quantum?: number } = {}
): TurnRange {
  const tailWindow = options.tailWindow ?? TAIL_HYDRATION_WINDOW;
  const minPrefetch = options.minPrefetch ?? MIN_PREFETCH_TURNS;
  const screens = options.screens ?? PREFETCH_SCREENS;
  const quantum = Math.max(1, options.quantum ?? HYDRATION_RANGE_QUANTUM);
  if (turnCount <= 0) return { from: 0, to: 0 };
  if (!visible) return { from: Math.max(0, turnCount - tailWindow), to: turnCount };
  const from = clamp(visible.from, 0, turnCount);
  const to = clamp(visible.to, from, turnCount);
  const span = Math.max(to - from, 1);
  const prefetch = Math.max(span * screens, minPrefetch);
  const start = Math.floor(Math.max(0, from - prefetch) / quantum) * quantum;
  const end = Math.min(turnCount, Math.ceil((to + prefetch) / quantum) * quantum);
  return { from: start, to: end };
}

export const isSameTurnRange = (left: TurnRange | null, right: TurnRange | null): boolean =>
  left === right ||
  (left !== null && right !== null && left.from === right.from && left.to === right.to);
