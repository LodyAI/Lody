import { Effect } from 'effect';
import { fail } from './errors';

/** Default upper bound of one remote round while a serial owner holds its permit. */
export const REMOTE_ROUND_DEADLINE_MS = 30_000;

/** Optional deadline configuration of a personal host. `sleep` replaces the timer, so
 * tests decide when a deadline elapses instead of waiting on wall-clock time. */
export interface PersonalHostDeadlines {
  readonly remoteMs?: number;
  readonly sleep?: (ms: number) => Effect.Effect<void>;
}

/**
 * Bounds remote work by interrupting it at the deadline, which releases every permit
 * it holds. The retryable result is `network`; the outcome of an interrupted write is
 * unknown, so callers keep its retained original or journal for the exact retry and
 * never sign or generate anything new for it.
 */
export const boundedBy =
  (deadlines: PersonalHostDeadlines | undefined) =>
  <A, E, R>(work: Effect.Effect<A, E, R>) => {
    const ms = deadlines?.remoteMs ?? REMOTE_ROUND_DEADLINE_MS;
    const elapsed = deadlines?.sleep ? deadlines.sleep(ms) : Effect.sleep(ms);
    return Effect.raceFirst(
      work,
      elapsed.pipe(Effect.andThen(Effect.fail(fail('network', 'deadline'))))
    );
  };
