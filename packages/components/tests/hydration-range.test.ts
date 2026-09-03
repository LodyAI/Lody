import { describe, expect, it } from 'vitest';
import {
  computeHydrationRange,
  HYDRATION_RANGE_QUANTUM,
  isSameTurnRange,
  MIN_PREFETCH_TURNS,
  TAIL_HYDRATION_WINDOW,
} from '../src/lib/conversation-view/hydration-range';
import { resolveVisibleTurnRange } from '../src/components/ai-gui/view';

describe('computeHydrationRange', () => {
  it('is the tail window before any scroll position is known', () => {
    expect(computeHydrationRange(null, 2_400)).toEqual({
      from: 2_400 - TAIL_HYDRATION_WINDOW,
      to: 2_400,
    });
    expect(computeHydrationRange(null, 10)).toEqual({ from: 0, to: 10 });
    expect(computeHydrationRange(null, 0)).toEqual({ from: 0, to: 0 });
  });

  it('prefetches two visible spans on each side, snapped to the quantum', () => {
    const range = computeHydrationRange({ from: 1_000, to: 1_012 }, 2_400);
    // span 12 → prefetch 24: [976, 1036) snaps to multiples of 8.
    expect(range).toEqual({ from: 976, to: 1_040 });
    expect(range.from % HYDRATION_RANGE_QUANTUM).toBe(0);
    expect(range.to % HYDRATION_RANGE_QUANTUM).toBe(0);
  });

  it('never prefetches less than the floor and clamps to the conversation', () => {
    expect(computeHydrationRange({ from: 2, to: 3 }, 2_400)).toEqual({
      from: 0,
      to: Math.ceil((3 + MIN_PREFETCH_TURNS) / HYDRATION_RANGE_QUANTUM) * HYDRATION_RANGE_QUANTUM,
    });
    expect(computeHydrationRange({ from: 2_390, to: 2_400 }, 2_400)).toEqual({
      from: 2_368,
      to: 2_400,
    });
  });

  it('keeps the same range object identity through isSameTurnRange', () => {
    const range = { from: 1, to: 2 };
    expect(isSameTurnRange(range, { from: 1, to: 2 })).toBe(true);
    expect(isSameTurnRange(range, { from: 1, to: 3 })).toBe(false);
    expect(isSameTurnRange(null, range)).toBe(false);
    expect(isSameTurnRange(null, null)).toBe(true);
  });
});

describe('resolveVisibleTurnRange', () => {
  const rows = [
    { turnIndex: 0 },
    { turnIndex: 1 },
    { turnIndex: 1 },
    { turnIndex: 1 },
    { turnIndex: 2 },
    { turnIndex: 3 },
  ];

  it('maps the rows under the viewport edges to a half-open turn window', () => {
    expect(resolveVisibleTurnRange(rows, 1, 4)).toEqual({ from: 1, to: 3 });
    expect(resolveVisibleTurnRange(rows, 2, 2)).toEqual({ from: 1, to: 2 });
  });

  it('clamps the leading-content and agent-activity rows into the list', () => {
    expect(resolveVisibleTurnRange(rows, -1, 99)).toEqual({ from: 0, to: 4 });
    expect(resolveVisibleTurnRange([], 0, 0)).toBeNull();
  });

  it('skips the empty-conversation row', () => {
    expect(resolveVisibleTurnRange([{ turnIndex: -1 }], 0, 0)).toBeNull();
    expect(resolveVisibleTurnRange([{ turnIndex: -1 }, { turnIndex: 5 }], 0, 1)).toEqual({
      from: 5,
      to: 6,
    });
  });
});
