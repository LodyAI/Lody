// @vitest-environment jsdom

/**
 * `WorkingGrid` contracts:
 *  - every mark on the page samples one shared sea, so its motion depends only
 *    on page position and the document timeline, never on when a mark mounted;
 *  - neighbouring sidebar marks move together, and a whole mark almost never
 *    sinks out of sight;
 *  - the animation stays on the compositor: Web Animations on HTML elements,
 *    touching only `transform` and `opacity`, cancelled on unmount.
 *
 * jsdom has no Web Animations API, so the component tests install a recording
 * `Element.prototype.animate` and assert which elements animate which properties.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { SidebarRowEndSlot } from '../src/components/sidebar-row-shared';
import { WorkingGrid } from '../src/ui/working-grid';
import {
  seaHeight,
  tileSeaPoint,
  WORKING_GRID_LOOP_MS,
  WORKING_GRID_WAVELENGTH,
} from '../src/ui/working-grid-sea';

/** The nine sea points of a 14px mark in the `row`-th 28px sidebar row. */
function sidebarMark(row: number): [number, number][] {
  const placement = { left: 240, top: row * 28, size: 14, rowPitch: 28 };
  return [0, 1, 2].flatMap((j) => [0, 1, 2].map((i) => tileSeaPoint(placement, i, j)));
}

function correlation(a: number[], b: number[]): number {
  const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const [ma, mb] = [mean(a), mean(b)];
  let num = 0;
  let da = 0;
  let db = 0;
  a.forEach((x, k) => {
    num += (x - ma) * (b[k]! - mb);
    da += (x - ma) ** 2;
    db += (b[k]! - mb) ** 2;
  });
  return num / Math.sqrt(da * db);
}

const LOOP_TIMES = Array.from({ length: 180 }, (_, k) => (k / 180) * WORKING_GRID_LOOP_MS);

describe('working grid sea', () => {
  it('loops seamlessly, so a baked keyframe loop has no seam', () => {
    for (const [x, y] of [[0, 0], [37.5, 12], [80, 144.25]] as const) {
      for (const t of [0, 1234, 20_000]) {
        expect(seaHeight(x, y, t + WORKING_GRID_LOOP_MS, 1.3)).toBeCloseTo(seaHeight(x, y, t, 1.3), 9);
      }
    }
  });

  it('stitches list rows so a wave leaves one mark and enters the next', () => {
    const size = 14;
    const upper = { left: 0, top: 0, size, rowPitch: 28 };
    const lower = { left: 0, top: 28, size, rowPitch: 28 };
    // Stitched: the next mark's top row is one cell below this mark's bottom row.
    expect(tileSeaPoint(lower, 0, 0)[1] - tileSeaPoint(upper, 0, 2)[1]).toBe(1);
    // Unstitched: the real 14px of sea between the marks is sampled.
    const realUpper = { ...upper, rowPitch: null };
    const realLower = { ...lower, rowPitch: null };
    expect(tileSeaPoint(realLower, 0, 0)[1] - tileSeaPoint(realUpper, 0, 2)[1]).toBe(4);
  });

  it('keeps the nine tiles of a mark visibly different', () => {
    // Long waves alone made every tile of a mark rise and fall as one block.
    let spread = 0;
    let samples = 0;
    for (let row = 0; row < 12; row += 1) {
      const tiles = sidebarMark(row);
      for (const t of LOOP_TIMES) {
        const heights = tiles.map(([x, y]) => seaHeight(x, y, t, WORKING_GRID_WAVELENGTH));
        const mean = heights.reduce((sum, h) => sum + h, 0) / heights.length;
        spread += Math.sqrt(heights.reduce((sum, h) => sum + (h - mean) ** 2, 0) / heights.length);
        samples += 1;
      }
    }
    expect(spread / samples).toBeGreaterThan(0.15);
  });

  it('gives neighbouring sidebar marks one rhythm', () => {
    // Short waves alone put adjacent rows in antiphase and every mark looked like
    // it ran on its own; whole marks must brighten and dim together with their neighbours.
    const series = Array.from({ length: 24 }, (_, row) => {
      const tiles = sidebarMark(row);
      return LOOP_TIMES.map(
        (t) =>
          tiles.reduce((sum, [x, y]) => sum + seaHeight(x, y, t, WORKING_GRID_WAVELENGTH), 0) / 9
      );
    });
    const adjacent =
      series.slice(1).reduce((sum, s, row) => sum + correlation(series[row]!, s), 0) /
      (series.length - 1);
    expect(adjacent).toBeGreaterThan(0.35);
  });

  it('almost never lets a whole mark sink out of sight', () => {
    // Long waves can put all nine tiles in one trough; keep that rare.
    let samples = 0;
    let dark = 0;
    for (let row = 0; row < 40; row += 1) {
      const tiles = sidebarMark(row);
      for (const t of LOOP_TIMES) {
        const brightest = Math.max(
          ...tiles.map(([x, y]) => seaHeight(x, y, t, WORKING_GRID_WAVELENGTH))
        );
        samples += 1;
        if (brightest < 0.15) dark += 1;
      }
    }
    expect(dark / samples).toBeLessThan(0.012);
  });
});

interface RecordedAnimation {
  target: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  startTime: number | null;
  cancelled: boolean;
}

let recorded: RecordedAnimation[];
let reducedMotion: boolean;
let container: HTMLDivElement;
let root: Root | undefined;
const originalAnimate = Element.prototype.animate;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  recorded = [];
  reducedMotion = false;
  Element.prototype.animate = function animate(
    this: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions
  ) {
    const entry: RecordedAnimation = {
      target: this,
      keyframes: keyframes as Keyframe[],
      options: options as KeyframeAnimationOptions,
      startTime: null,
      cancelled: false,
    };
    recorded.push(entry);
    return {
      set startTime(value: number | null) {
        entry.startTime = value;
      },
      cancel() {
        entry.cancelled = true;
      },
    } as unknown as Animation;
  };
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion') && reducedMotion,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = undefined;
  container.remove();
  Element.prototype.animate = originalAnimate;
  window.matchMedia = originalMatchMedia;
});

function render(node: React.ReactElement) {
  flushSync(() => root?.render(node));
}

const COMPOSITOR_KEYS = new Set(['transform', 'opacity', 'offset', 'easing']);

describe('WorkingGrid', () => {
  it('bakes one seamless loop per tile and plays it on the compositor', () => {
    render(<WorkingGrid />);

    expect(recorded).toHaveLength(9);
    for (const animation of recorded) {
      expect(animation.target.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
      for (const frame of animation.keyframes) {
        for (const key of Object.keys(frame)) expect(COMPOSITOR_KEYS.has(key)).toBe(true);
      }
      const first = animation.keyframes[0]!;
      const last = animation.keyframes.at(-1)!;
      expect([first.offset, last.offset]).toEqual([0, 1]);
      expect([last.transform, last.opacity]).toEqual([first.transform, first.opacity]);
      expect(animation.options.duration).toBe(WORKING_GRID_LOOP_MS);
      expect(animation.options.iterations).toBe(Infinity);
      // Pinned to the document timeline's origin: marks share one sea.
      expect(animation.startTime).toBe(0);
    }
  });

  it('cancels every loop when the mark unmounts', () => {
    render(<WorkingGrid />);
    render(<div />);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((animation) => animation.cancelled)).toBe(true);
  });

  it('keeps every tile between minScale and maxScale of its cell', () => {
    const size = 30;
    const gap = 0.5;
    render(
      <WorkingGrid size={size} gap={gap} minScale={0.25} maxScale={0.8} brightness="steady" />
    );
    const cell = size / (3 + 2 * gap);
    const tile = container.querySelector<HTMLElement>('[data-working-grid-tile]')!;
    const drawn = parseFloat(tile.style.width);
    // A tile box is drawn at maxScale of its cell; the animation only shrinks it.
    expect(drawn).toBeCloseTo(cell * 0.8, 9);
    for (const animation of recorded) {
      for (const frame of animation.keyframes) {
        const factor = Number(/scale\(([\d.]+)\)/.exec(String(frame.transform))![1]);
        expect(drawn * factor).toBeGreaterThanOrEqual(cell * 0.25 - 1e-3);
        expect(factor).toBeLessThanOrEqual(1);
        expect('opacity' in frame).toBe(false);
      }
    }
  });

  it('stays still when there is nothing to animate or motion is reduced', () => {
    render(<WorkingGrid scale="none" brightness="steady" />);
    expect(recorded).toHaveLength(0);

    reducedMotion = true;
    render(<WorkingGrid key="reduced" />);
    expect(recorded).toHaveLength(0);
    expect(container.querySelectorAll('[data-working-grid-tile]')).toHaveLength(9);
  });

  it('is the sidebar row working mark', () => {
    render(<SidebarRowEndSlot isWorking />);
    const mark = container.querySelector('[data-session-working-indicator]');
    expect(mark?.matches('[data-working-grid]')).toBe(true);
    expect(mark?.closest('[data-session-row-indicator]')).not.toBeNull();
  });
});
