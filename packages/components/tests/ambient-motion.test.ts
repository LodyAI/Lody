// @vitest-environment jsdom

/**
 * Ambient-motion frame budget contracts:
 *  - quantized animations change only on ONE shared tick grid, so the compositor
 *    draws at most `fps` frames a second (unaligned steps would interleave);
 *  - only infinite animations are touched, only while the window is unfocused,
 *    and focus restores each animation's own timing;
 *  - animations that start while unfocused join the budget.
 *
 * jsdom has no Web Animations API, so animations are small timing records with
 * the `getTiming`/`updateTiming`/`startTime` surface the budget uses.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  adoptAmbientAnimations,
  installAmbientMotionBudget,
  quantizeAmbientTiming,
} from '../src/lib/ambient-motion';
import { crestDelayMs, WORKING_GRID_RHYTHM, workingGridWaves } from '../src/ui/working-grid-sea';

type Timing = { duration: number; delay: number; easing: string; iterations: number };

class FakeAnimation {
  timing: Timing;
  startTime: number | null;
  constructor(timing: Partial<Timing> & { duration: number }, startTime: number | null = 0) {
    this.timing = { delay: 0, easing: 'linear', iterations: Infinity, ...timing };
    this.startTime = startTime;
  }
  effect = {
    getTiming: () => ({ ...this.timing }),
    updateTiming: (next: Partial<Timing>) => {
      this.timing = { ...this.timing, ...next };
    },
  };
}

const asAnimations = (list: FakeAnimation[]) => list as unknown as Animation[];
const TICK = 1000 / 30;

/** Timeline times at which a quantized animation's value changes, over `spanMs`. */
function changeTimes(animation: FakeAnimation, spanMs: number): number[] {
  const { duration, delay, easing } = animation.timing;
  // An unquantized animation changes every frame; say so instead of passing vacuously.
  expect(easing).toMatch(/^steps\(\d+\)$/);
  const steps = Number(/steps\((\d+)\)/.exec(easing)?.[1]);
  const step = duration / steps;
  const origin = (animation.startTime ?? 0) + delay;
  const times: number[] = [];
  for (let k = Math.ceil(-origin / step); origin + k * step <= spanMs; k++) {
    times.push(origin + k * step);
  }
  return times;
}

const onGrid = (time: number) => Math.abs(time / TICK - Math.round(time / TICK)) < 1e-6;

let focused = true;
let running: FakeAnimation[] = [];
let uninstall: () => void = () => {};

beforeEach(() => {
  focused = true;
  running = [];
  document.hasFocus = () => focused;
  document.getAnimations = () => asAnimations(running);
});

afterEach(() => {
  uninstall();
  uninstall = () => {};
});

function blur() {
  focused = false;
  window.dispatchEvent(new Event('blur'));
}

function focus() {
  focused = true;
  window.dispatchEvent(new Event('focus'));
}

describe('quantizeAmbientTiming', () => {
  it('puts every working-grid wave change on one shared 30 fps grid', () => {
    const waves = [...workingGridWaves('across'), ...workingGridWaves('down'), WORKING_GRID_RHYTHM];
    const animations = waves.flatMap((wave) =>
      [0, 0.13, 0.5, 0.871].map((phase) => {
        const animation = new FakeAnimation({
          duration: wave.periodMs,
          delay: crestDelayMs(phase, wave.periodMs),
        });
        animation.effect.updateTiming(quantizeAmbientTiming(animation.timing, 30));
        return animation;
      })
    );
    const allChanges = new Set<number>();
    for (const animation of animations) {
      for (const time of changeTimes(animation, 10_000)) {
        expect(onGrid(time)).toBe(true);
        allChanges.add(Math.round(time / TICK));
      }
    }
    // Together they change on at most 30 distinct instants a second.
    expect(allChanges.size).toBeLessThanOrEqual(Math.ceil((10_000 / 1000) * 30) + 1);
  });

  it('keeps a loop period within half a tick of the original', () => {
    for (const duration of [1000, 1900, 2200, 2700, 3600, 1234]) {
      const quantized = quantizeAmbientTiming({ duration, delay: 0 }, 30);
      expect(Math.abs(quantized.duration - duration)).toBeLessThanOrEqual(TICK / 2);
    }
  });
});

describe('installAmbientMotionBudget', () => {
  it('leaves a focused window untouched', () => {
    const grid = new FakeAnimation({ duration: 1900, delay: -420, easing: 'ease' });
    running = [grid];
    uninstall = installAmbientMotionBudget(window);
    expect(grid.timing).toEqual({
      duration: 1900,
      delay: -420,
      easing: 'ease',
      iterations: Infinity,
    });
  });

  it('quantizes infinite animations on blur and restores them on focus', () => {
    const grid = new FakeAnimation({ duration: 2700, delay: -1234.5, easing: 'ease-in-out' });
    const spinner = new FakeAnimation({ duration: 1000 }, 51_234.7);
    const collapse = new FakeAnimation({ duration: 480, iterations: 1, easing: 'ease-in' });
    running = [grid, spinner, collapse];
    uninstall = installAmbientMotionBudget(window);

    blur();
    for (const animation of [grid, spinner]) {
      for (const time of changeTimes(animation, 60_000)) expect(onGrid(time)).toBe(true);
    }
    expect(collapse.timing).toEqual({ duration: 480, delay: 0, easing: 'ease-in', iterations: 1 });

    focus();
    expect(grid.timing).toEqual({
      duration: 2700,
      delay: -1234.5,
      easing: 'ease-in-out',
      iterations: Infinity,
    });
    expect(spinner.timing).toEqual({
      duration: 1000,
      delay: 0,
      easing: 'linear',
      iterations: Infinity,
    });
  });

  it('starts quantized when installed into an unfocused window', () => {
    focused = false;
    const grid = new FakeAnimation({ duration: 1900, delay: -500 });
    running = [grid];
    uninstall = installAmbientMotionBudget(window);
    expect(grid.timing.easing).toBe('steps(57)');
  });

  it('budgets script animations handed over while unfocused, and only then', () => {
    uninstall = installAmbientMotionBudget(window);
    const whileFocused = new FakeAnimation({ duration: 1900 });
    adoptAmbientAnimations(asAnimations([whileFocused]));
    expect(whileFocused.timing.easing).toBe('linear');

    blur();
    const whileBlurred = new FakeAnimation({ duration: 1900, delay: -700 });
    adoptAmbientAnimations(asAnimations([whileBlurred]));
    for (const time of changeTimes(whileBlurred, 10_000)) expect(onGrid(time)).toBe(true);
  });

  it('budgets CSS animations that start while unfocused, including pseudo-elements', () => {
    uninstall = installAmbientMotionBudget(window);
    blur();
    const host = document.createElement('span');
    document.body.appendChild(host);
    const shimmer = new FakeAnimation({ duration: 2200 }, 90_017.3);
    host.getAnimations = (options?: GetAnimationsOptions) =>
      asAnimations(options?.subtree ? [shimmer] : []);
    host.dispatchEvent(new Event('animationstart', { bubbles: true }));
    for (const time of changeTimes(shimmer, 100_000)) expect(onGrid(time)).toBe(true);
    host.remove();
  });

  it('restores every animation when uninstalled', () => {
    const grid = new FakeAnimation({ duration: 1900, delay: -300, easing: 'ease' });
    running = [grid];
    const remove = installAmbientMotionBudget(window);
    blur();
    remove();
    expect(grid.timing).toEqual({
      duration: 1900,
      delay: -300,
      easing: 'ease',
      iterations: Infinity,
    });
    focused = true;
  });
});
