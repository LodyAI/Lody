import { Context, Layer } from 'effect';

export interface LabClockShape {
  readonly nowMs: () => number;
}

export class LabClock extends Context.Tag('lody/e2ee-lab/LabClock')<LabClock, LabClockShape>() {}

export function makeLabClock(nowMs: () => number): LabClockShape {
  return { nowMs };
}

export const LiveLabClock = Layer.succeed(
  LabClock,
  makeLabClock(() => Date.now())
);

/** Mutable test clock. Advance with `set` / `advance`. */
export function makeTestClock(initial = 0): LabClockShape & {
  set(ms: number): void;
  advance(ms: number): void;
} {
  let current = initial;
  return {
    nowMs: () => current,
    set(ms) {
      current = ms;
    },
    advance(ms) {
      current += ms;
    },
  };
}

export function TestLabClock(clock: LabClockShape = makeTestClock()): Layer.Layer<LabClock> {
  return Layer.succeed(LabClock, clock);
}
