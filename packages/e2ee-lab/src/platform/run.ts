import { Cause, Effect, Exit, Fiber, Scope } from 'effect';

function unwrap<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  if (exit.cause.reasons.length > 1)
    throw new AggregateError(
      exit.cause.reasons.map((reason) => Cause.squash(Cause.fromReasons([reason]))),
      'Multiple lab failures'
    );
  throw Cause.squash(exit.cause);
}

/** Native callback boundary. Only synchronous adapter bookkeeping belongs here. */
export function runLabSync<A, E>(effect: Effect.Effect<A, E>): A {
  return unwrap(Effect.runSyncExit(effect));
}

/** One owner for actual Node/SDK callback fibers. New orchestration composes
 * Effects directly. Closing rejects admission and awaits callback finalizers. */
export class LabCallbackRunner {
  private readonly scope = Scope.makeUnsafe();
  private closing?: Promise<void>;
  private closed = false;

  async run<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> {
    if (this.closed) throw new Error('lab-run-closed');
    const fiber = runLabSync(
      effect.pipe(Effect.provideService(Scope.Scope, this.scope), Effect.forkIn(this.scope))
    );
    return unwrap(await Effect.runPromiseExit(Fiber.join(fiber)));
  }

  close(): Promise<void> {
    this.closed = true;
    return (this.closing ??= Effect.runPromiseExit(Scope.close(this.scope, Exit.void)).then(
      unwrap
    ));
  }
}
