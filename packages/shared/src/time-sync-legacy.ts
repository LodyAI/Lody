import { Deferred, Effect, Fiber } from 'effect';
import { maintainTimeSync } from './time-sync-maintenance';
import { createServerTimeFetcher } from './time-sync';

/**
 * @deprecated Execution door for CLI startup and the React application effect.
 * Delete when those application owners compose maintainTimeSync in their Scope.
 * stop aborts the active fetch; syncTime fences any late publication.
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
