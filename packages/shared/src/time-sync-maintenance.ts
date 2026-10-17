import { Deferred, Effect, Fiber } from 'effect';
import { syncTime, createServerTimeFetcher, type ServerTimeFetcher } from './time-sync';

/** Cloud application-owned calibration; failures preserve the last offset. */
export const maintainTimeSync = Effect.fnUntraced(function* (
  getServerTime: ServerTimeFetcher,
  options: {
    readonly onError?: (error: unknown) => void;
    readonly onFirstAttempt?: Effect.Effect<void>;
  } = {}
) {
  const sample = Effect.tryPromise({
    try: (signal) => syncTime(getServerTime, signal),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => options.onError?.(error)).pipe(Effect.catchCause(() => Effect.void))
    )
  );
  yield* sample;
  yield* options.onFirstAttempt ?? Effect.void;
  yield* sample.pipe(Effect.delay(30_000), Effect.forever);
});

/**
 * @deprecated Execution door for CLI startup and the React application effect.
 * Delete when those application owners compose maintainTimeSync in their Scope.
 * stop aborts the active fetch; syncTime rejects any late publication.
 */
export function startTimeSyncLegacy(url: string, onError?: (error: unknown) => void) {
  const ready = Deferred.makeUnsafe<void>();
  const fiber = Effect.runFork(
    maintainTimeSync(createServerTimeFetcher(url), {
      onError,
      onFirstAttempt: Deferred.succeed(ready, undefined),
    }).pipe(Effect.ensuring(Deferred.succeed(ready, undefined)))
  );
  let stopped: Promise<void> | undefined;
  return {
    ready: Effect.runPromise(Deferred.await(ready)),
    stop: (): Promise<void> => (stopped ??= Effect.runPromise(Fiber.interrupt(fiber))),
  };
}
