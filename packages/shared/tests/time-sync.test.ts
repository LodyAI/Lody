import { it as effectIt } from '@effect/vitest';
import { Clock, Deferred, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getServerNow,
  getServerTimeOffset,
  resetTimeSync,
  syncTime,
  createServerTimeFetcher,
} from '../src/time-sync';
import { maintainTimeSync } from '../src/time-sync-maintenance';
import { startTimeSyncLegacy } from '../src/time-sync-legacy';
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

  it('keeps calibrated timestamps integral when the RTT midpoint is fractional', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_001)
      .mockReturnValue(2_000);

    await syncTime(async () => 1_500);

    expect(getServerTimeOffset()).toBe(500);
    expect(getServerNow()).toBe(2_500);
    expect(Number.isInteger(getServerNow())).toBe(true);
  });

  it('does not publish cancelled or superseded samples', async () => {
    const late = Promise.withResolvers<number>();
    const controller = new AbortController();
    const pending = syncTime(() => late.promise, controller.signal);
    controller.abort();
    await syncTime(async () => Date.now() + 500);
    late.resolve(Date.now() - 120_000);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(getServerTimeOffset()).toBe(500);

    const old = Promise.withResolvers<number>();
    const older = syncTime(() => old.promise);
    await syncTime(async () => Date.now() + 750);
    old.resolve(Date.now() - 120_000);
    await older;
    expect(getServerTimeOffset()).toBe(750);
  });

  it('rejects a sample taken across a clock correction without losing calibration', async () => {
    let wall = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    vi.spyOn(performance, 'now').mockReturnValue(0);
    await syncTime(async () => wall + 500);
    await expect(
      syncTime(async () => {
        wall -= 120_000;
        return wall;
      })
    ).rejects.toThrow('System clock changed');
    expect(getServerTimeOffset()).toBe(500);
  });

  it('aborts the actual HTTP request when its application owner stops', async () => {
    const started = Promise.withResolvers<AbortSignal>();
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      started.resolve(init.signal as AbortSignal);
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const owner = startTimeSyncLegacy('https://old.invalid/api/time');
    const signal = await started.promise;
    await owner.stop();
    expect(signal.aborted).toBe(true);
    await owner.ready;
    expect(getServerTimeOffset()).toBe(0);
    vi.unstubAllGlobals();
  });

  it('the fetcher retains a deadline through response-body consumption', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => ({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      }));
      const outcome = createServerTimeFetcher('https://synthetic.invalid/api/time', 50)();
      const rejected = expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('releases an unterminated error body instead of leaving it behind on every retry', async () => {
    let response: Response | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('unfinished error body'));
            init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
              once: true,
            });
          },
        }),
        { status: 503 }
      );
      return response;
    });
    try {
      await expect(createServerTimeFetcher('https://synthetic.invalid/api/time')()).rejects.toThrow(
        'Time sync failed: 503'
      );
      // Fetch abort errors a returned response body, even after headers resolve.
      await expect(response?.body?.getReader().read()).rejects.toMatchObject({
        name: 'AbortError',
      });
    } finally {
      vi.unstubAllGlobals();
    }
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
          }).pipe(Effect.provideService(Clock.Clock, clockWithWallTime(clock, wall)))
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
        yield* TestClock.adjust(1_000);
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
              onError: () => Deferred.doneUnsafe(failed, Effect.void),
            }
          ).pipe(Effect.provideService(Clock.Clock, clockWithWallTime(clock, wall)))
        );
        yield* Deferred.await(ready);
        offline = true;
        wallError = 0;
        yield* TestClock.adjust(1_000);
        yield* Deferred.await(failed);
        expect(getServerTimeOffset()).toBe(-120_000);
        offline = false;
        yield* TestClock.adjust(30_000);
        expect(getServerTimeOffset()).toBe(0);
        // A suspended monotonic clock may not advance while wall time advances.
        // Re-sample rather than serializing the frozen monotonic estimate.
        const beforeSuspend = getServerNow();
        suspendedElapsed = 600_000;
        yield* TestClock.adjust(1_000);
        expect(getServerTimeOffset()).toBe(0);
        expect(getServerNow() - beforeSuspend).toBe(601_000);
        yield* Fiber.interrupt(maintenance);
      })
  );
});
