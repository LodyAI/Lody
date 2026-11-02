import { SYNC_CONFIRMATION_TIMEOUT_MS } from '../lib/loro/timeout-utils';
import { Cause, Data, Effect, Schedule } from 'effect';

/** Confirmation is read-only. Publishing and notification submission are never retried. */
export interface TurnCompletionPorts {
  readonly persist: Effect.Effect<void, unknown>;
  readonly confirm: Effect.Effect<boolean, unknown>;
  readonly publishUnread: Effect.Effect<void, unknown>;
  readonly notify: Effect.Effect<void, unknown>;
}

export class TurnCompletionUnconfirmed extends Data.TaggedError('TurnCompletionUnconfirmed') {
  override readonly message = 'Turn history sync is unconfirmed; completion signals withheld';
}

/** The caller owns this finite program after releasing the turn, not in its presence scope. */
export const publishTurnCompletion = Effect.fnUntraced(function* (ports: TurnCompletionPorts) {
  // Local writes cannot be detached by cancellation: the host retains them until settled.
  yield* Effect.uninterruptible(ports.persist);
  yield* ports.confirm.pipe(
    Effect.flatMap((confirmed) =>
      confirmed ? Effect.void : Effect.fail(new TurnCompletionUnconfirmed())
    ),
    Effect.retry({ schedule: Schedule.spaced('1 second') }),
    Effect.timeoutOrElse({
      duration: SYNC_CONFIRMATION_TIMEOUT_MS,
      orElse: () => Effect.fail(new TurnCompletionUnconfirmed()),
    })
  );
  // A failure of one presentation channel must not prevent the other from running.
  const results = yield* Effect.all([Effect.exit(ports.publishUnread), Effect.exit(ports.notify)], {
    concurrency: 'unbounded',
  }).pipe(Effect.uninterruptible);
  const cause = results.reduce<Cause.Cause<unknown>>(
    (accumulated, result) =>
      result._tag === 'Failure' ? Cause.combine(accumulated, result.cause) : accumulated,
    Cause.empty
  );
  if (cause.reasons.length) return yield* Effect.failCause(cause);
  return undefined;
});
