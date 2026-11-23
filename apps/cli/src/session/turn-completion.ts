import { SYNC_CONFIRMATION_TIMEOUT_MS } from '../lib/loro/timeout-utils';
import { Cause, Data, Effect, Schedule } from 'effect';

/**
 * How agent work that outlived its Turn ended: it went idle (`settled`), its process
 * ended while work was still reported (`interrupted`), or a newer Turn took over the
 * Session before either (`superseded`).
 */
export type NativeWorkSettlement = 'settled' | 'interrupted' | 'superseded';

/** What the live agent of a released Turn still reports, read from the same agent instance. */
export interface NativeWorkWatch {
  /** Null once the agent reports neither its own model turn nor background tasks. */
  readonly current: () => 'running' | 'background' | null;
  /** Observes that instance; `ended` means its process or registration is gone. */
  readonly subscribe: (onEvent: (event: 'changed' | 'ended' | 'superseded') => void) => () => void;
}

/**
 * Waits on lifecycle events, never on a clock: the agent process bounds the wait,
 * because idle GC retires background-only agents after its own cap.
 */
export const awaitNativeWorkSettlement = (watch: NativeWorkWatch) =>
  Effect.callback<NativeWorkSettlement>((resume) => {
    if (watch.current() === null) {
      resume(Effect.succeed('settled'));
      return;
    }
    let unsubscribe: (() => void) | undefined;
    let done = false;
    const finish = (settlement: NativeWorkSettlement) => {
      if (done) return;
      done = true;
      unsubscribe?.();
      resume(Effect.succeed(settlement));
    };
    unsubscribe = watch.subscribe((event) => {
      if (event === 'superseded') finish('superseded');
      else if (event === 'ended') finish('interrupted');
      else if (watch.current() === null) finish('settled');
    });
    if (done) unsubscribe();
    return Effect.sync(() => {
      done = true;
      unsubscribe?.();
    });
  });

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
