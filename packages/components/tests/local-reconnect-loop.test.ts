import { describe, expect, it } from 'vitest';
import { Duration, Effect, TestClock, TestContext } from 'effect';
import {
  createLocalReconnectLoop,
  type LocalReconnectLoop,
  type LocalReconnectTriggerReason,
} from '../src/providers/local-reconnect-loop';

// Let the run() promise chain (reconnect await + finally) settle between
// virtual-clock steps.
const flushMicrotasks = Effect.promise(async () => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
});

type LoopHarness = {
  loop: LocalReconnectLoop;
  calls: Array<{ force: boolean; triggerReason?: LocalReconnectTriggerReason }>;
  setHasProblem: (value: boolean) => void;
  setCanRun: (value: boolean) => void;
};

/**
 * Builds a loop wired to a TestClock-backed runtime and hands it to `body`
 * together with mutable canRun/hasProblem knobs. All waits inside the loop
 * run on virtual time (TestClock.adjust), so backoff pacing is asserted
 * deterministically — no real timers, no fake-timer patching.
 */
const withTestLoop = (
  body: (harness: LoopHarness) => Effect.Effect<void>,
  loopOptions: {
    onReconnect?: (
      context: { force: boolean; triggerReason?: LocalReconnectTriggerReason },
      harness: LoopHarness
    ) => void;
  } = {}
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* Effect.runtime<never>();
      const calls: Array<{ force: boolean; triggerReason?: LocalReconnectTriggerReason }> = [];
      let hasProblem = false;
      let canRun = true;
      const harness: LoopHarness = {
        loop: null as unknown as LocalReconnectLoop,
        calls,
        setHasProblem: (value) => {
          hasProblem = value;
        },
        setCanRun: (value) => {
          canRun = value;
        },
      };
      harness.loop = createLocalReconnectLoop({
        runtime,
        canRun: () => canRun,
        hasProblem: () => hasProblem,
        reconnect: async (context) => {
          calls.push(context);
          loopOptions.onReconnect?.(context, harness);
        },
        onStateChange: () => {},
        // Deterministic backoff: retry n waits (n + 1) seconds.
        computeDelayMs: (attempt) => (attempt + 1) * 1_000,
      });
      yield* body(harness);
      harness.loop.stop();
    }).pipe(Effect.provide(TestContext.TestContext))
  );

describe('createLocalReconnectLoop', () => {
  it('passes force: true for trigger() runs and force: false for scheduled retries', async () => {
    await withTestLoop(
      ({ loop, calls, setHasProblem }) =>
        Effect.gen(function* () {
          // External wake signal (visibility/online/token refresh): forced run
          // even though hasProblem() is false.
          loop.trigger();
          yield* flushMicrotasks;
          expect(calls).toEqual([{ force: true }]);

          // Registry-flagged problem: scheduled retry is not forced. First
          // attempt fires immediately (delay 0).
          setHasProblem(true);
          loop.update();
          yield* TestClock.adjust(Duration.millis(0));
          yield* flushMicrotasks;
          expect(calls).toEqual([{ force: true }, { force: false }]);
        }),
      {
        onReconnect: ({ force }, harness) => {
          if (!force) {
            harness.setHasProblem(false);
          }
        },
      }
    );
  });

  it('passes the external trigger reason to forced reconnects', async () => {
    await withTestLoop(({ loop, calls }) =>
      Effect.gen(function* () {
        loop.trigger('visibility-wake');
        yield* flushMicrotasks;
        expect(calls).toEqual([{ force: true, triggerReason: 'visibility-wake' }]);
      })
    );
  });

  it('does not forgive retry history when an external trigger forces an immediate attempt', async () => {
    await withTestLoop(({ loop, calls, setHasProblem }) =>
      Effect.gen(function* () {
        setHasProblem(true);
        loop.update();
        yield* TestClock.adjust(Duration.millis(0));
        yield* flushMicrotasks;
        expect(calls).toHaveLength(1);

        // A fresh credential deserves an immediate attempt, but the outage is
        // still the same one. After that forced attempt, retry 3 must retain
        // the accumulated 2s delay instead of restarting at 1s.
        loop.trigger('token-refresh');
        yield* flushMicrotasks;
        expect(calls).toHaveLength(2);
        yield* TestClock.adjust(Duration.millis(1_999));
        yield* flushMicrotasks;
        expect(calls).toHaveLength(2);
        yield* TestClock.adjust(Duration.millis(1));
        yield* flushMicrotasks;
        expect(calls).toHaveLength(3);
      })
    );
  });

  it('spaces persistent-failure retries by the computed backoff on the virtual clock', async () => {
    await withTestLoop(({ loop, calls, setHasProblem }) =>
      Effect.gen(function* () {
        setHasProblem(true);
        loop.update();
        // Attempt 1 is immediate (delay 0).
        yield* TestClock.adjust(Duration.millis(0));
        yield* flushMicrotasks;
        expect(calls.length).toBe(1);

        // Attempt 2 waits computeDelayMs(0) = 1s: not a millisecond earlier.
        yield* TestClock.adjust(Duration.millis(999));
        yield* flushMicrotasks;
        expect(calls.length).toBe(1);
        yield* TestClock.adjust(Duration.millis(1));
        yield* flushMicrotasks;
        expect(calls.length).toBe(2);

        // Attempt 3 waits computeDelayMs(1) = 2s.
        yield* TestClock.adjust(Duration.millis(1_999));
        yield* flushMicrotasks;
        expect(calls.length).toBe(2);
        yield* TestClock.adjust(Duration.millis(1));
        yield* flushMicrotasks;
        expect(calls.length).toBe(3);

        // Recovery: the pending retry wakes, sees the problem is gone, and
        // exits without another reconnect call. Backoff is only forgiven after
        // the problem stays cleared for the healthy dwell (30s), so give the
        // dwell time to elapse; the next problem then starts again from an
        // immediate first attempt.
        setHasProblem(false);
        yield* TestClock.adjust(Duration.seconds(60));
        yield* flushMicrotasks;
        expect(calls.length).toBe(3);
        setHasProblem(true);
        loop.update();
        yield* TestClock.adjust(Duration.millis(0));
        yield* flushMicrotasks;
        expect(calls.length).toBe(4);
      })
    );
  });

  it('stop() cancels the pending retry wait', async () => {
    await withTestLoop(({ loop, calls, setHasProblem }) =>
      Effect.gen(function* () {
        setHasProblem(true);
        loop.update();
        yield* TestClock.adjust(Duration.millis(0));
        yield* flushMicrotasks;
        expect(calls.length).toBe(1);
        expect(loop.isActive()).toBe(true);

        loop.stop();
        expect(loop.isActive()).toBe(false);
        yield* TestClock.adjust(Duration.minutes(5));
        yield* flushMicrotasks;
        expect(calls.length).toBe(1);
      })
    );
  });

  it('does not reset backoff during the transient recovery window of a reconnect attempt', async () => {
    await withTestLoop(
      ({ loop, calls, setHasProblem }) =>
        Effect.gen(function* () {
          // Persistent failure whose reconnect momentarily clears the problem
          // (rooms cycle through 'connecting') before it reappears — the
          // offline local-first storm shape.
          setHasProblem(true);
          loop.update();
          yield* TestClock.adjust(Duration.millis(0));
          yield* flushMicrotasks;
          expect(calls.length).toBe(1);

          // Problem reappears right after the attempt settles. The transient
          // healthy read must NOT have reset the counter: the next attempt
          // still owes computeDelayMs(0) = 1s instead of firing immediately.
          setHasProblem(true);
          loop.update();
          yield* TestClock.adjust(Duration.millis(0));
          yield* flushMicrotasks;
          expect(calls.length).toBe(1);
          yield* TestClock.adjust(Duration.millis(999));
          yield* flushMicrotasks;
          expect(calls.length).toBe(1);
          yield* TestClock.adjust(Duration.millis(1));
          yield* flushMicrotasks;
          expect(calls.length).toBe(2);

          // And the delay keeps growing: attempt 3 owes computeDelayMs(1) = 2s.
          setHasProblem(true);
          loop.update();
          yield* TestClock.adjust(Duration.millis(1_999));
          yield* flushMicrotasks;
          expect(calls.length).toBe(2);
          yield* TestClock.adjust(Duration.millis(1));
          yield* flushMicrotasks;
          expect(calls.length).toBe(3);
        }),
      {
        onReconnect: (_context, harness) => {
          // Each reconnect attempt leaves rooms in the transient 'connecting'
          // window where the registry reports no problem.
          harness.setHasProblem(false);
        },
      }
    );
  });

  it('update() while healthy cancels the pending retry and resets pacing', async () => {
    await withTestLoop(({ loop, calls, setHasProblem }) =>
      Effect.gen(function* () {
        setHasProblem(true);
        loop.update();
        yield* TestClock.adjust(Duration.millis(0));
        yield* flushMicrotasks;
        expect(calls.length).toBe(1);

        // Problem clears via an external event before the retry fires.
        setHasProblem(false);
        loop.update();
        yield* TestClock.adjust(Duration.minutes(5));
        yield* flushMicrotasks;
        expect(calls.length).toBe(1);

        // Next problem starts from an immediate attempt again.
        setHasProblem(true);
        loop.update();
        yield* TestClock.adjust(Duration.millis(0));
        yield* flushMicrotasks;
        expect(calls.length).toBe(2);
      })
    );
  });
});
