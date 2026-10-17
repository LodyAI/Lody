import { Clock, Effect } from 'effect';
import { syncTime, type ServerTimeFetcher } from './time-sync';

const CHECK_INTERVAL_MS = 1_000;
const RESYNC_INTERVAL_MS = 30_000;
const CLOCK_DISCONTINUITY_MS = 1_000;

/**
 * Cloud application-owned calibration. Keep epoch timestamps based on the wall
 * clock, including across suspend. Monotonic time only detects discontinuities
 * and schedules refreshes; it is never serialized or substituted for epoch time.
 * A failed refresh preserves the last offset and remains retryable.
 */
export const maintainTimeSync = Effect.fnUntraced(function* (
  getServerTime: ServerTimeFetcher,
  options: {
    readonly onError?: (error: unknown) => void;
    readonly onFirstAttempt?: Effect.Effect<void>;
  } = {}
) {
  let previousWall = yield* Clock.currentTimeMillis;
  let previousElapsed = yield* Clock.monotonicTimeNanos;
  let lastAttempt = previousElapsed;
  let first = true;
  while (true) {
    const wall = yield* Clock.currentTimeMillis;
    const elapsed = yield* Clock.monotonicTimeNanos;
    const discontinuity = Math.abs(
      wall - previousWall - Number(elapsed - previousElapsed) / 1_000_000
    );
    previousWall = wall;
    previousElapsed = elapsed;
    if (
      first ||
      discontinuity > CLOCK_DISCONTINUITY_MS ||
      Number(elapsed - lastAttempt) / 1_000_000 >= RESYNC_INTERVAL_MS
    ) {
      lastAttempt = elapsed;
      yield* Effect.tryPromise({
        try: (signal) => syncTime(getServerTime, signal),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => options.onError?.(error)).pipe(Effect.catchCause(() => Effect.void))
        )
      );
      if (first) {
        first = false;
        yield* options.onFirstAttempt ?? Effect.void;
      }
    }
    yield* Effect.sleep(CHECK_INTERVAL_MS);
  }
});
