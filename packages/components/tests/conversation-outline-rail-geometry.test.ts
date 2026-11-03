import { describe, expect, it } from 'vitest';
import {
  ACTIVE_BAR_OVERHANG,
  ACTIVE_TICK_WIDTH,
  TICK_PITCH,
  RAIL_TRACK_WIDTH,
  RAIL_EDGE_FADE_LENGTH,
  TICK_WIDTHS,
  outlineTickRestingWidth,
  outlineTickWidth,
  outlineTickWidthAt,
} from '../src/components/ai-gui/conversation-outline-rail-geometry';

const RESTING = [...TICK_WIDTHS];
const LIGHTEST = Math.min(...RESTING);
const HEAVIEST = Math.max(...RESTING);

/** The widths a run of ticks takes when the pointer sits on the middle one. */
const profileAround = (restingWidths: readonly number[], hoveredIndex: number): number[] =>
  restingWidths.map((resting, index) => outlineTickWidth(resting, index - hoveredIndex));

describe('outlineTickWidth', () => {
  it('makes the tick under the cursor the longest, whatever its neighbours weigh', () => {
    // The regression this exists for: while the bell was ADDED to each tick's
    // resting width, a heavy neighbour outgrew the tick being pointed at.
    const restingWidths = [HEAVIEST, HEAVIEST, HEAVIEST, LIGHTEST, HEAVIEST, HEAVIEST, HEAVIEST];
    const widths = profileAround(restingWidths, 3);
    const hovered = widths[3] ?? 0;

    for (const [index, width] of widths.entries()) {
      if (index === 3) continue;
      expect(width).toBeLessThan(hovered);
    }
  });

  it('falls off monotonically on both sides of the cursor', () => {
    // Uniform resting widths, because that is what isolates the bell. Across
    // MIXED weights the profile is deliberately not monotonic past the bell's
    // radius: the swell melts back into the rail's resting texture, and a heavy
    // round beyond the radius is simply long again.
    const restingWidths = Array.from({ length: 11 }, () => LIGHTEST);
    const widths = profileAround(restingWidths, 5);

    for (let index = 1; index <= 5; index += 1) {
      expect(widths[5 - index]).toBeLessThan(widths[5 - index + 1] ?? Infinity);
      expect(widths[5 + index]).toBeLessThan(widths[5 + index - 1] ?? Infinity);
    }
  });

  it('barely disturbs a tick at the edge of the radius', () => {
    // The fringe of the blend pulls a heavy tick very slightly toward the
    // bell's base. Keep that sub-pixel, or the rail visibly breathes far from
    // the cursor.
    for (const resting of RESTING) {
      expect(Math.abs(outlineTickWidth(resting, 4) - resting)).toBeLessThan(1);
    }
  });

  it('gives the cursor the same length regardless of the round’s weight', () => {
    // At the peak the bell fully replaces the resting width, so the tip of the
    // swell is stable as the pointer travels across rounds of different sizes.
    const peaks = RESTING.map((resting) => outlineTickWidth(resting, 0));
    for (const peak of peaks) {
      expect(peak).toBeCloseTo(peaks[0] ?? 0, 6);
    }
  });

  it('leaves ticks outside the radius at their resting width', () => {
    for (const resting of RESTING) {
      expect(outlineTickWidth(resting, 5)).toBe(resting);
      expect(outlineTickWidth(resting, 50)).toBe(resting);
    }
  });
});

describe('outlineTickWidthAt', () => {
  it('leaves every tick at rest while the pointer is off the rail', () => {
    for (const index of [0, 3, 40]) {
      expect(outlineTickWidthAt(HEAVIEST, index, -1)).toBe(HEAVIEST);
    }
  });
});

describe('rail track', () => {
  it('is wide enough for anything the rail can paint', () => {
    // The strip is an `overflow-y: auto` box, which makes the x axis `auto`
    // too — a magnified element wider than the track would scroll the rail
    // sideways rather than simply extending.
    for (const resting of RESTING) {
      for (const distance of [0, 1, 2, 3, 4, 9]) {
        const tick = outlineTickWidth(resting, distance);
        expect(tick).toBeLessThanOrEqual(RAIL_TRACK_WIDTH);
        expect(tick + ACTIVE_BAR_OVERHANG).toBeLessThanOrEqual(RAIL_TRACK_WIDTH);
      }
    }
    expect(ACTIVE_TICK_WIDTH).toBeLessThanOrEqual(RAIL_TRACK_WIDTH);
  });
});

describe('outlineTickRestingWidth', () => {
  it('grows with weight', () => {
    expect(outlineTickRestingWidth(0)).toBeLessThan(outlineTickRestingWidth(3));
  });
});

describe('rail edge fade length', () => {
  it('spans enough ticks for the taper to be visible', () => {
    // Two ticks was too subtle to read as "there is more here" on a rail this
    // low-contrast. The mask itself is the shared `buildScrollEdgeFadeMask`,
    // covered by `tests/scroll-edge-fade.test.ts`.
    expect(RAIL_EDGE_FADE_LENGTH).toBeGreaterThanOrEqual(TICK_PITCH * 5);
  });
});
