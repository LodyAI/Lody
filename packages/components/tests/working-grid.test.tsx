// @vitest-environment jsdom

/**
 * `WorkingGrid` contracts:
 *  - every mark on the page samples one shared sea, so its phases depend only on
 *    page position and the document timeline, never on when a mark mounted;
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
  crestDelayMs,
  tileSeaPoint,
  wavePhase,
  workingGridWaves,
} from '../src/ui/working-grid-sea';

const sin01 = (turns: number) => 0.5 + 0.5 * Math.sin(2 * Math.PI * turns);
const frac = (value: number) => value - Math.floor(value);

/** Height a crest-first sine loop shows at timeline time `t`, given its delay. */
function loopHeightAt(t: number, delayMs: number, periodMs: number): number {
  const progress = frac((t - delayMs) / periodMs);
  return sin01(0.25 - progress);
}

describe('working grid sea', () => {
  it('pins each loop to the sea phase at its position, whenever it mounted', () => {
    const [wave] = workingGridWaves('across');
    for (const phase of [0, 0.1, 0.25, 0.5, 0.73, 0.999]) {
      const delay = crestDelayMs(phase, wave.periodMs);
      expect(delay).toBeLessThanOrEqual(0);
      expect(delay).toBeGreaterThan(-wave.periodMs);
      for (const t of [0, 333, 1900, 4210]) {
        // The travelling wave: height at time t is sin01(phase − t / period).
        expect(loopHeightAt(t, delay, wave.periodMs)).toBeCloseTo(
          sin01(phase - t / wave.periodMs),
          9
        );
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

  it('gives neighbouring tiles neighbouring phases', () => {
    const [wave] = workingGridWaves('across');
    const placement = { left: 0, top: 0, size: 14, rowPitch: 28 };
    const [x0, y0] = tileSeaPoint(placement, 0, 0);
    const [x1, y1] = tileSeaPoint(placement, 1, 0);
    const step = Math.abs(wavePhase(wave, x1, y1, 1.5) - wavePhase(wave, x0, y0, 1.5));
    // One tile apart is a small fraction of a wavelength, so the sea looks continuous.
    expect(Math.min(step, 1 - step)).toBeLessThan(0.25);
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
  it('animates both wave layers of all nine tiles on the compositor', () => {
    render(<WorkingGrid />);

    expect(recorded).toHaveLength(18);
    for (const animation of recorded) {
      expect(animation.target.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
      for (const frame of animation.keyframes) {
        for (const key of Object.keys(frame)) expect(COMPOSITOR_KEYS.has(key)).toBe(true);
      }
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

  it('spans exactly minScale to maxScale of the cell', () => {
    const size = 30;
    const gap = 0.5;
    render(
      <WorkingGrid size={size} gap={gap} minScale={0.25} maxScale={0.8} brightness="steady" />
    );
    const cell = size / (3 + 2 * gap);
    const tile = container.querySelector<HTMLElement>('[data-working-grid-tile]')!;
    // At a double crest both layers sit at scale 1: the tile is maxScale of its cell.
    expect(parseFloat(tile.style.width)).toBeCloseTo(cell * 0.8, 9);
    const scales = recorded.map((animation) =>
      Number(/scale\(([\d.]+)\)/.exec(String(animation.keyframes[1]!.transform))![1])
    );
    // At a double trough the two stacked layers multiply down to minScale of the cell.
    expect(parseFloat(tile.style.width) * scales[0]! * scales[1]!).toBeCloseTo(cell * 0.25, 9);
    expect(recorded.every((a) => a.keyframes.every((frame) => !('opacity' in frame)))).toBe(true);
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
