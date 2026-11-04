import { it as effectIt } from '@effect/vitest';
import { Clock, Deferred, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getServerNow, getServerTimeOffset, resetTimeSync, syncTime } from '../src/time-sync';
import { maintainTimeSync } from '../src/time-sync-maintenance';
import { isFreshLodyPresenceState } from '../src/presence';
import { makeLoroStreamsTokenWebPorts } from '../src/loro-streams-auth';

function clockWithWallTime(clock: Clock.Clock, wall: () => number): Clock.Clock {
  return {
    currentTimeMillisUnsafe: wall,
    currentTimeMillis: Effect.sync(wall),
    currentTimeNanosUnsafe: () => BigInt(wall()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(wall()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos,
    sleep: (duration) => clock.sleep(duration),
  };
}

describe('time sync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetTimeSync();
  });

  it('does not publish cancelled samples after a successor calibrates', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const late = Promise.withResolvers<number>();
    const controller = new AbortController();
    const pending = syncTime(() => late.promise, controller.signal);
    controller.abort();
    await syncTime(async () => Date.now() + 500);
    late.resolve(Date.now() - 120_000);
    const failure = await pending.catch((error: unknown) => error);
    expect(getServerTimeOffset()).toBe(500);
    expect(failure).toMatchObject({ name: 'AbortError' });
  });

  it('rejects a sample taken across a clock correction without losing calibration', async () => {
    let wall = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    vi.spyOn(performance, 'now').mockReturnValue(0);
    await syncTime(async () => wall + 500);
    const failure = await syncTime(async () => {
      wall -= 120_000;
      return wall;
    }).catch((error: unknown) => error);
    expect(getServerTimeOffset()).toBe(500);
    expect(failure).toMatchObject({ message: 'System clock changed during time synchronization' });
  });
});

describe('maintained time calibration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetTimeSync();
  });

  for (const initialError of [120_000, -120_000]) {
    effectIt.effect(`recovers independent consumers after correcting ${initialError}ms`, () =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const epoch = 2_000_000_000_000;
        let wallError = initialError;
        const wall = () => epoch + clock.currentTimeMillisUnsafe() + wallError;
        vi.spyOn(Date, 'now').mockImplementation(wall);
        vi.spyOn(performance, 'now').mockImplementation(
          () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000
        );
        const completed = Deferred.makeUnsafe<void>();
        const maintenance = yield* Effect.forkChild(
          maintainTimeSync(async () => epoch + clock.currentTimeMillisUnsafe(), {
            onFirstAttempt: Deferred.succeed(completed, undefined),
          })
        );
        yield* Deferred.await(completed);
        expect(getServerTimeOffset()).toBe(-initialError);
        wallError = 0;
        // Consumer is an independent process/module calibrated after correction.
        vi.resetModules();
        const consumer = yield* Effect.promise(() => import('../src/time-sync'));
        yield* Effect.promise(() => consumer.syncTime(async () => wall()));
        if (initialError > 0) {
          expect(
            isFreshLodyPresenceState({ updatedAt: getServerNow() }, consumer.getServerNow())
          ).toBe(false);
        }
        yield* TestClock.adjust(30_000);
        expect(getServerTimeOffset()).toBe(0);
        const heartbeat = { updatedAt: getServerNow() };
        expect(isFreshLodyPresenceState(heartbeat, consumer.getServerNow())).toBe(true);
        expect(Number.isInteger(heartbeat.updatedAt)).toBe(true);
        // The same fresh timestamp contract is used by native Clock + offset consumers.
        const nativeClock = clockWithWallTime(clock, wall);
        const nativeNow = yield* makeLoroStreamsTokenWebPorts({
          credential: Effect.succeed('synthetic-credential'),
        }).now.pipe(Effect.provideService(Clock.Clock, nativeClock));
        expect(nativeNow).toBe(getServerNow());
        yield* TestClock.adjust(90_000);
        expect(isFreshLodyPresenceState(heartbeat, consumer.getServerNow())).toBe(false);
        yield* Fiber.interrupt(maintenance);
      })
    );
  }

  effectIt.effect(
    'retries failed recalibration and handles suspend without a monotonic epoch anchor',
    () =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        let wallError = 120_000;
        let suspendedElapsed = 0;
        let offline = false;
        const failed = Deferred.makeUnsafe<void>();
        const serverNow = () =>
          2_000_000_000_000 + clock.currentTimeMillisUnsafe() + suspendedElapsed;
        const wall = () => serverNow() + wallError;
        vi.spyOn(Date, 'now').mockImplementation(wall);
        vi.spyOn(performance, 'now').mockImplementation(
          () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000
        );
        const ready = Deferred.makeUnsafe<void>();
        const maintenance = yield* Effect.forkChild(
          maintainTimeSync(
            async () => {
              if (offline) throw new Error('offline');
              return serverNow();
            },
            {
              onFirstAttempt: Deferred.succeed(ready, undefined),
              onError: () => {
                Deferred.doneUnsafe(failed, Effect.void);
                throw new Error('synthetic diagnostic failure');
              },
            }
          )
        );
        yield* Deferred.await(ready);
        offline = true;
        wallError = 0;
        yield* TestClock.adjust(30_000);
        yield* Deferred.await(failed);
        expect(getServerTimeOffset()).toBe(-120_000);
        offline = false;
        yield* TestClock.adjust(30_000);
        expect(getServerTimeOffset()).toBe(0);
        // A suspended monotonic clock may not advance while wall time advances.
        // Re-sample rather than serializing the frozen monotonic estimate.
        const beforeSuspend = getServerNow();
        suspendedElapsed = 600_000;
        expect(getServerNow() - beforeSuspend).toBe(600_000);
        yield* TestClock.adjust(30_000);
        expect(getServerTimeOffset()).toBe(0);
        expect(getServerNow() - beforeSuspend).toBe(630_000);
        yield* Fiber.interrupt(maintenance);
      })
  );
});
