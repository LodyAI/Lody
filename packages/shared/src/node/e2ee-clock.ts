import { Clock, Effect } from 'effect';

declare const __LODY_E2E_CLOCK_BUILD__: boolean;

/** Bind the existing E2EE clock service only in an explicit E2E build/run.
 * Ordinary/release bundles remove the file adapter entirely. */
function withFileClock<A, E, R>(work: Effect.Effect<A, E, R>) {
  return Effect.suspend(() => {
    if (process.env.LODY_E2E !== '1') return work;
    return Effect.gen(function* () {
      const base = yield* Clock.Clock;
      const adapter = yield* Effect.tryPromise({
        try: () => import('./e2ee-clock-file'),
        catch: () => new Error('e2ee_test_clock_unavailable'),
      });
      const clock = yield* Effect.try({
        try: () => adapter.e2eeTestClock(base),
        catch: () => new Error('e2ee_test_clock_unavailable'),
      });
      return yield* Effect.provideService(work, Clock.Clock, clock);
    });
  });
}

// Select the whole implementation at compile time so even non-minified builds
// discard the dynamic file import and its module.
export const withE2eeTestClock =
  typeof __LODY_E2E_CLOCK_BUILD__ !== 'undefined' && __LODY_E2E_CLOCK_BUILD__
    ? withFileClock
    : <A, E, R>(work: Effect.Effect<A, E, R>) => work;
