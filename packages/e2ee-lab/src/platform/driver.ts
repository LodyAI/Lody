import { Cause, Data, Effect, Exit, Fiber, Queue, Scope } from 'effect';
import type { LabRuntime } from './runtime';
import { canPermitEvent, type LabEvent } from '../pure/scheduler';
import { choiceKey, eventIdentity, identitiesEqual, type ScheduleChoice } from '../pure/schedule';
import type { Divergence } from '../pure/replay';

export class LabDriverError extends Data.TaggedError('LabDriverError')<{
  readonly code: 'configuration' | 'budget' | 'divergence' | 'stopped' | 'external-permit';
  readonly divergence?: Divergence;
}> {}

export interface DriverOptions {
  /** Count actual permits, not notifications or elapsed wall time. */
  readonly maxSteps: number;
  /** Explicit caller-owned stop signal; no implicit protocol deadline. */
  readonly stop?: Effect.Effect<void>;
}

export function leftoverRequested(runtime: LabRuntime): readonly LabEvent[] {
  return runtime.events().filter((event) => event.status === 'requested');
}

/**
 * One finite permit-only recording/replay. Owns runtime cancellation/settlement;
 * start/attack/crash actions and entropy replay require the full executor.
 * The input schedule is captured before work begins, including identity fields.
 */
export const driveLabPermits = Effect.fn('Lab.drivePermits')(function* <A, E, R>(
  runtime: LabRuntime,
  recorded: 'record' | readonly ScheduleChoice[],
  work: Effect.Effect<A, E, R>,
  options: DriverOptions
) {
  const run = Effect.scoped(
    Effect.gen(function* () {
      if (
        runtime.schedulingMode !== 'manual' ||
        runtime.permitLog.length !== 0 ||
        !Number.isSafeInteger(options.maxSteps) ||
        options.maxSteps < 0
      ) {
        return yield* new LabDriverError({ code: 'configuration' });
      }
      const choices =
        recorded === 'record'
          ? 'record'
          : recorded.map((choice) => ({
              ...choice,
              identity: { ...choice.identity },
            }));
      if (
        choices !== 'record' &&
        choices.some(
          (choice) =>
            choice.kind !== 'permit' ||
            !Number.isSafeInteger(choice.occurrence) ||
            choice.occurrence < 0
        )
      ) {
        return yield* new LabDriverError({ code: 'configuration' });
      }
      const maxSteps = options.maxSteps;
      const stop = options.stop;
      const changes = yield* runtime.changes();
      let permits = 0;
      const divergence = (): Divergence | undefined => {
        const requested = leftoverRequested(runtime);
        const next = choices === 'record' ? undefined : choices[permits];
        const active = runtime.events().filter((event) => event.status === 'permitted');
        if (!next && requested.length === 0 && active.length === 0) return undefined;
        return {
          index: permits,
          field: next
            ? 'schedule.missing'
            : active.length
              ? 'schedule.unfinished'
              : 'schedule.extra',
          expected: next ? choiceKey(next) : 'none',
          actual:
            [...requested, ...active]
              .map((event) =>
                choiceKey({
                  kind: 'permit',
                  identity: eventIdentity(event, runtime.events()),
                  occurrence: occurrence(event),
                })
              )
              .join(',') || 'missing',
        };
      };
      const occurrence = (event: LabEvent): number => {
        const identity = eventIdentity(event, runtime.events());
        return runtime.permitLog.filter((choice) => identitiesEqual(choice.identity, identity))
          .length;
      };
      const tick = Effect.fnUntraced(function* () {
        if (runtime.permitLog.length !== permits) {
          return yield* new LabDriverError({ code: 'external-permit' });
        }
        while (true) {
          const events = runtime.events();
          const next = choices === 'record' ? undefined : choices[permits];
          const selected = events.find(
            (event) =>
              event.status === 'requested' &&
              canPermitEvent(runtime.state, event.eventId) &&
              (choices === 'record' ||
                (next &&
                  identitiesEqual(eventIdentity(event, events), next.identity) &&
                  occurrence(event) === next.occurrence))
          );
          if (!selected) return yield* Effect.void;
          if (permits >= maxSteps) {
            return yield* new LabDriverError({ code: 'budget', divergence: divergence() });
          }
          yield* Effect.sync(() => {
            // A granted synchronous phase can finish and re-enter tick immediately.
            // Publish the driver's count before resuming that phase.
            permits += 1;
            runtime.permit(selected.eventId);
          });
        }
      });
      const watch = Effect.gen(function* () {
        yield* tick();
        yield* Effect.forever(Queue.take(changes).pipe(Effect.andThen(tick())));
      });
      const completed = work.pipe(
        Effect.flatMap((value) =>
          Effect.gen(function* () {
            yield* tick();
            const remaining = divergence();
            if (remaining)
              return yield* new LabDriverError({ code: 'divergence', divergence: remaining });
            return value;
          })
        )
      );
      // Claim the failure before closing gates: native phases may resume
      // synchronously and otherwise replace budget/stop with runtime-closed.
      let firstFailure: Cause.Cause<E | LabDriverError> | undefined;
      const closeOnFailure = <B, S>(effect: Effect.Effect<B, E | LabDriverError, S>) =>
        effect.pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.sync(() => {
                  firstFailure ??= exit.cause;
                  runtime.close();
                })
              : Effect.void
          )
        );
      const running = Effect.raceFirst(closeOnFailure(completed), closeOnFailure(watch));
      const stopped = stop?.pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const error = new LabDriverError({ code: 'stopped', divergence: divergence() });
            firstFailure ??= Cause.fail(error);
            runtime.close();
            return Effect.fail(error);
          })
        )
      );
      return yield* (stopped ? Effect.raceFirst(running, stopped) : running).pipe(
        Effect.catchCause((cause) => Effect.failCause(firstFailure ?? cause))
      );
    })
  );
  // An independent child Scope lets cancellation close gates before interrupting
  // a caller's uninterruptible native borrower. raceFirst also waits its loser.
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => Scope.makeUnsafe()),
    (scope) => run.pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
    (scope) =>
      Effect.sync(() => runtime.close()).pipe(
        Effect.andThen(Scope.close(scope, Exit.void)),
        Effect.ensuring(runtime.disposeEffect())
      )
  );
});
