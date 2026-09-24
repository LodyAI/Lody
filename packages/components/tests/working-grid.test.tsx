// @vitest-environment jsdom

/**
 * `WorkingGrid` contracts:
 *  - every mark on the page samples one shared sea, so its phases depend only on
 *    page position and the document timeline, never on when a mark mounted;
 *  - a long rhythm wave pulses whole marks down a list;
 *  - the animation stays on the compositor: Web Animations on HTML elements,
 *    touching only `transform` and `opacity`, cancelled on unmount;
 *  - every mark holds still while the user reads outside the sidebar.
 *
 * jsdom has no Web Animations API, so the component tests install a recording
 * `Element.prototype.animate` and assert which elements animate which properties.
 */

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { SidebarRowEndSlot } from '../src/components/sidebar-row-shared';
import { WorkingGrid } from '../src/ui/working-grid';
import { WorkingGridCollapse } from '../src/ui/working-grid-collapse';
import { WorkingStatusMark } from '../src/ui/working-status-mark';
import { READING_IDLE_MS, setWorkingGridReadingPause } from '../src/ui/working-grid-reading';
import {
  crestDelayMs,
  tileSeaPoint,
  wavePhase,
  WORKING_GRID_RHYTHM,
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

  it('pulses the rhythm down a list, neighbours nearly together', () => {
    const phases = [0, 1, 2, 3, 4].map((row) => {
      const [x, y] = tileSeaPoint({ left: 0, top: row * 28, size: 14, rowPitch: 28 }, 1, 1);
      return wavePhase(WORKING_GRID_RHYTHM, x, y, 1);
    });
    for (let row = 1; row < phases.length; row += 1) {
      const step = frac(phases[row]! - phases[row - 1]!);
      // One row further down is a small, consistent step along the same wave.
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(0.1);
    }
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
  paused: boolean;
  cancelled: boolean;
  finish: () => void;
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
      paused: false,
      cancelled: false,
      finish: () => {},
    };
    const finished = new Promise<void>((resolve) => {
      entry.finish = resolve;
    });
    recorded.push(entry);
    return {
      finished,
      set startTime(value: number | null) {
        entry.startTime = value;
        entry.paused = false;
      },
      set currentTime(_value: number | null) {},
      pause() {
        entry.paused = true;
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

const TRANSFORM_OR_OPACITY = (frame: Keyframe) =>
  Object.keys(frame).every((key) => COMPOSITOR_KEYS.has(key));
const scaleOf = (frame: Keyframe) => Number(/scale\(([\d.]+)\)/.exec(String(frame.transform))![1]);

describe('WorkingGrid', () => {
  it('plays one main wave with a small interfering ripple by default', () => {
    render(<WorkingGrid minScale={0.3} maxScale={0.9} lightCompensation={false} />);

    // Per tile: the main wave on the outer box, a smaller ripple on the face.
    const main = recorded.filter((a) => a.target.hasAttribute('data-working-grid-tile'));
    const ripple = recorded.filter((a) => a.target.classList.contains('bg-current'));
    expect(main).toHaveLength(9);
    expect(ripple).toHaveLength(9);
    // Each wave has one shape and period everywhere; only the phase differs, so
    // each mark down a list is a delayed copy of the one above.
    for (const wave of [main, ripple]) {
      expect(new Set(wave.map((a) => JSON.stringify(a.keyframes))).size).toBe(1);
      expect(new Set(wave.map((a) => a.options.duration)).size).toBe(1);
      expect(new Set(wave.map((a) => a.options.delay)).size).toBeGreaterThan(1);
    }
    expect(recorded.every((a) => a.keyframes.every(TRANSFORM_OR_OPACITY))).toBe(true);
    // The ripple swings less than the main wave, and together they bottom out at
    // minScale relative to the drawn (maxScale) tile.
    const mainLow = scaleOf(main[0]!.keyframes[1]!);
    const rippleLow = scaleOf(ripple[0]!.keyframes[1]!);
    expect(rippleLow).toBeGreaterThan(mainLow);
    expect(mainLow * rippleLow).toBeCloseTo(0.3 / 0.9, 9);
  });

  it('raises the floors and tile size in a light theme', () => {
    // jsdom has no ThemeProvider, so the theme resolves to light.
    const props = { size: 30, gap: 0.5, minScale: 0.3, maxScale: 0.9, ripple: 0 } as const;
    const measure = (lightCompensation: boolean) => {
      recorded = [];
      render(
        <WorkingGrid
          key={String(lightCompensation)}
          {...props}
          lightCompensation={lightCompensation}
        />
      );
      const tile = container.querySelector<HTMLElement>('[data-working-grid-tile]')!;
      const drawn = parseFloat(tile.style.width);
      const trough = recorded[0]!.keyframes[1]!;
      return { drawn, smallest: drawn * scaleOf(trough), dimmest: Number(trough.opacity) };
    };
    const plain = measure(false);
    const light = measure(true);
    expect(light.drawn).toBeGreaterThan(plain.drawn);
    expect(light.smallest).toBeGreaterThan(plain.smallest);
    expect(light.dimmest).toBeGreaterThan(plain.dimmest);
  });

  it('drops the ripple layer when ripple is 0', () => {
    render(<WorkingGrid ripple={0} />);
    expect(recorded).toHaveLength(9);
    expect(recorded.every((a) => a.target.hasAttribute('data-working-grid-tile'))).toBe(true);
  });

  it('animates the mark and both layers of every tile on the compositor', () => {
    render(<WorkingGrid waves={2} />);

    // One rhythm loop on the mark, two wave layers on each of nine tiles.
    expect(recorded).toHaveLength(19);
    const startTimes = new Set(recorded.map((animation) => animation.startTime));
    // One shared clock: every loop starts at the same point on the timeline.
    expect(startTimes.size).toBe(1);
    for (const animation of recorded) {
      expect(animation.target.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
      expect(animation.keyframes.every(TRANSFORM_OR_OPACITY)).toBe(true);
      expect(animation.options.iterations).toBe(Infinity);
    }
  });

  it('slows every loop by the speed factor', () => {
    render(<WorkingGrid waves={2} speed={0.5} />);
    const durations = new Set(recorded.map((animation) => animation.options.duration));
    const [wave1, wave2] = workingGridWaves('across');
    expect(durations).toEqual(
      new Set([wave1.periodMs / 0.5, wave2.periodMs / 0.5, WORKING_GRID_RHYTHM.periodMs / 0.5])
    );
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
      <WorkingGrid
        waves={2}
        lightCompensation={false}
        size={size}
        gap={gap}
        minScale={0.25}
        maxScale={0.8}
        minOpacity={0.7}
        maxOpacity={0.7}
      />
    );
    const cell = size / (3 + 2 * gap);
    const tile = container.querySelector<HTMLElement>('[data-working-grid-tile]')!;
    // At a double crest both layers sit at scale 1: the tile is maxScale of its cell.
    expect(parseFloat(tile.style.width)).toBeCloseTo(cell * 0.8, 9);
    // Equal opacities hold brightness steady: no rhythm loop, no opacity keyframes.
    expect(recorded).toHaveLength(18);
    expect(recorded.every((a) => a.keyframes.every((frame) => !('opacity' in frame)))).toBe(true);
    const [outer, inner] = recorded;
    // At a double trough the two stacked layers multiply down to minScale of the cell.
    const trough = scaleOf(outer!.keyframes[1]!) * scaleOf(inner!.keyframes[1]!);
    expect(parseFloat(tile.style.width) * trough).toBeCloseTo(cell * 0.25, 9);
  });

  it('keeps brightness between minOpacity and maxOpacity', () => {
    render(
      <WorkingGrid
        waves={2}
        lightCompensation={false}
        minScale={0.3}
        minOpacity={0.4}
        maxOpacity={0.8}
        rhythm={0.5}
      />
    );
    const [rhythm, outer, inner] = recorded;
    const opacity = (animation: RecordedAnimation, at: number) =>
      Number(animation.keyframes[at]!.opacity);
    // Crest everywhere: the mark sits at maxOpacity and the tiles at full.
    expect(opacity(rhythm!, 0) * opacity(outer!, 0) * opacity(inner!, 0)).toBeCloseTo(0.8, 9);
    // Trough everywhere: the three loops multiply down to minOpacity.
    expect(opacity(rhythm!, 1) * opacity(outer!, 1) * opacity(inner!, 1)).toBeCloseTo(0.4, 9);
  });

  it('lets tiles vanish, longer the further minScale goes below zero', () => {
    /** Share of one tile layer's loop spent fully empty. */
    const emptyShare = (minScale: number) => {
      recorded = [];
      render(<WorkingGrid key={minScale} waves={2} minScale={minScale} maxScale={0.8} />);
      // The inner layer (the tile face) is the one allowed to empty the tile; the
      // outer layer only swells, so a whole mark never empties at once.
      const outers = recorded.filter((a) => a.target.hasAttribute('data-working-grid-tile'));
      for (const outer of outers) expect(outer.keyframes.every((f) => scaleOf(f) > 0)).toBe(true);
      const layer = recorded.find((a) => a.target.classList.contains('bg-current'))!;
      const frames = layer.keyframes;
      let empty = 0;
      for (let k = 1; k < frames.length; k += 1) {
        if (scaleOf(frames[k - 1]!) === 0 && scaleOf(frames[k]!) === 0) {
          empty += frames[k]!.offset! - frames[k - 1]!.offset!;
        }
      }
      // Always a seamless loop that starts at full size.
      expect(scaleOf(frames[0]!)).toBe(1);
      expect(scaleOf(frames.at(-1)!)).toBe(1);
      expect(frames.every((frame) => scaleOf(frame) >= 0)).toBe(true);
      return empty;
    };
    const atZero = emptyShare(0);
    const atMinus02 = emptyShare(-0.2);
    const atMinus04 = emptyShare(-0.4);
    expect(atZero).toBe(0);
    expect(atMinus02).toBeGreaterThan(0);
    expect(atMinus04).toBeGreaterThan(atMinus02);
  });

  it('stays still when there is nothing to animate or motion is reduced', () => {
    render(<WorkingGrid scale="none" minOpacity={0.8} maxOpacity={0.8} />);
    expect(recorded).toHaveLength(0);

    reducedMotion = true;
    render(<WorkingGrid key="reduced" />);
    expect(recorded).toHaveLength(0);
    expect(container.querySelectorAll('[data-working-grid-tile]')).toHaveLength(9);
  });

  it('holds every mark still while the user reads outside the sidebar', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      setWorkingGridReadingPause(true);
      render(
        <div>
          <div data-working-grid-region="">
            <WorkingGrid />
            <button type="button">row</button>
          </div>
          <p>conversation</p>
        </div>
      );
      const sidebar = container.querySelector('button')!;
      const reading = container.querySelector('p')!;

      // Clicking inside the sidebar is not reading.
      sidebar.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(recorded.some((animation) => animation.paused)).toBe(false);

      // Scrolling the conversation freezes every loop on its current frame...
      reading.dispatchEvent(new Event('wheel', { bubbles: true }));
      expect(recorded.every((animation) => animation.paused)).toBe(true);

      // ...until the reader has been quiet for a while.
      vi.advanceTimersByTime(READING_IDLE_MS - 1);
      expect(recorded.every((animation) => animation.paused)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(recorded.some((animation) => animation.paused)).toBe(false);
      // Resumed together, on one shared clock.
      expect(new Set(recorded.map((animation) => animation.startTime)).size).toBe(1);

      // Moving back into the sidebar resumes at once.
      reading.dispatchEvent(new Event('keydown', { bubbles: true }));
      expect(recorded.every((animation) => animation.paused)).toBe(true);
      sidebar.dispatchEvent(new Event('pointerover', { bubbles: true }));
      expect(recorded.some((animation) => animation.paused)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is the sidebar row working mark', () => {
    render(<SidebarRowEndSlot isWorking />);
    const mark = container.querySelector('[data-session-working-indicator]');
    expect(mark?.matches('[data-working-grid]')).toBe(true);
    expect(mark?.closest('[data-session-row-indicator]')).not.toBeNull();
  });
});

describe('WorkingGridCollapse', () => {
  it('spins and gathers the tiles, then pops the dot, on the compositor', () => {
    render(<WorkingGridCollapse />);
    const targets = (selector: string) => recorded.filter((a) => a.target.matches(selector)).length;
    expect(targets('[data-collapse-grid]')).toBe(1);
    expect(targets('[data-collapse-tile]')).toBe(9);
    expect(targets('[data-collapse-dot]')).toBe(1);
    expect(recorded.every((a) => a.keyframes.every(TRANSFORM_OR_OPACITY))).toBe(true);
    // The dot overshoots its size before settling: the bounce.
    const dot = recorded.find((a) => a.target.matches('[data-collapse-dot]'))!;
    const scales = dot.keyframes.map(scaleOf);
    // Overshoots, dips below size, overshoots again (two bounces), then settles.
    const peaks = scales.filter(
      (v, i) => i > 0 && i < scales.length - 1 && v > 1 && v > scales[i - 1]! && v > scales[i + 1]!
    );
    expect(peaks.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...scales)).toBeGreaterThan(1.5);
    expect(scales.at(-1)).toBe(1);
  });

  it('plays once when a session finishes, then shows the unread dot', async () => {
    render(<SidebarRowEndSlot isWorking />);
    expect(container.querySelector('[data-session-working-indicator]')).not.toBeNull();

    recorded = [];
    render(<SidebarRowEndSlot isWorking={false} hasUnreadMessages />);
    expect(container.querySelector('[data-session-done-transition]')).not.toBeNull();

    // When the dot's settle animation finishes, the plain unread dot takes over.
    const dot = recorded.find((a) => a.target.matches('[data-collapse-dot]'))!;
    await act(async () => {
      dot.finish();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-session-done-transition]')).toBeNull();
    expect(container.querySelector('[data-session-unread-dot]')).not.toBeNull();
  });

  it('does not play for a session that was never working', () => {
    render(<SidebarRowEndSlot hasUnreadMessages />);
    expect(container.querySelector('[data-session-done-transition]')).toBeNull();
  });
});

describe('WorkingStatusMark', () => {
  const doneTransition = () => container.querySelector('[data-session-done-transition]');
  const grid = () => container.querySelector('[data-session-working-indicator]');
  const dot = () => container.querySelector('[data-session-unread-dot]');

  it('collapses into the dot when unread lands before work stops (how a turn ends)', () => {
    // The CLI writes the unread bump, then releases presence.
    render(<WorkingStatusMark working unread={false} />);
    render(<WorkingStatusMark working unread />);
    expect(grid()).not.toBeNull();
    render(<WorkingStatusMark working={false} unread />);
    expect(doneTransition()).not.toBeNull();
    expect(grid()).toBeNull();
  });

  it('shows the dot without the transition if work stops before unread lands', () => {
    render(<WorkingStatusMark working unread={false} />);
    render(<WorkingStatusMark working={false} unread={false} />);
    expect(container.childElementCount).toBe(0);
    render(<WorkingStatusMark working={false} unread />);
    expect(doneTransition()).toBeNull();
    expect(dot()).not.toBeNull();
  });

  it('goes back to the grid when the session starts working again', () => {
    render(<WorkingStatusMark working unread={false} />);
    render(<WorkingStatusMark working={false} unread />);
    expect(doneTransition()).not.toBeNull();
    render(<WorkingStatusMark working unread />);
    expect(grid()).not.toBeNull();
    expect(doneTransition()).toBeNull();
  });
});
