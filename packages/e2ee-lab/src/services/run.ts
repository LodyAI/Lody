import { Cause, Context, Effect, Exit, Fiber, Layer, Scope } from 'effect';
import { LiveLabLayer, type LabServices } from './live';

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

/** One owner for Layers, callback fibers and resources. Construction is inert;
 * the first run builds a fresh Context in the persistent scope. Close rejects
 * new work, interrupts active fibers, and awaits finalizers exactly once. */
export class LabRun<R = never> {
  private readonly scope = Scope.makeUnsafe();
  private context?: Promise<Context.Context<R>>;
  private closing?: Promise<void>;
  private closed = false;

  constructor(private readonly layer: Layer.Layer<R>) {}

  async run<A, E>(effect: Effect.Effect<A, E, R | Scope.Scope>): Promise<A> {
    if (this.closed) throw new Error('lab-run-closed');
    if (!this.context) {
      const acquisition = runLabSync(
        Effect.forkIn(Layer.buildWithScope(this.layer, this.scope), this.scope)
      );
      this.context = Effect.runPromiseExit(Fiber.join(acquisition)).then(unwrap);
    }
    const context = await this.context;
    if (this.closed) throw new Error('lab-run-closed');
    const exit = await Effect.runPromiseExit(
      effect.pipe(
        Effect.provideContext(Context.add(context, Scope.Scope, this.scope)),
        Effect.forkIn(this.scope),
        Effect.flatMap(Fiber.join)
      )
    );
    return unwrap(exit);
  }

  runSync<A, E>(effect: Effect.Effect<A, E, R>): A {
    if (this.closed) throw new Error('lab-run-closed');
    if (this.context) throw new Error('lab-run-already-started');
    const context = unwrap(Effect.runSyncExit(Layer.buildWithScope(this.layer, this.scope)));
    this.context = Promise.resolve(context);
    return unwrap(Effect.runSyncExitWith(context)(effect));
  }

  addFinalizer(finalizer: Effect.Effect<void>): void {
    if (this.closed) throw new Error('lab-run-closed');
    runLabSync(Scope.addFinalizer(this.scope, finalizer));
  }

  close(): Promise<void> {
    this.closed = true;
    return (this.closing ??= Effect.runPromiseExit(Scope.close(this.scope, Exit.void)).then(
      unwrap
    ));
  }
}

/** Single-call boundary for descriptions whose resources do not escape. */
export async function runLabPromise<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R>
): Promise<A> {
  const run = new LabRun(layer);
  try {
    return await run.run(effect);
  } finally {
    await run.close();
  }
}

export function runLiveLabPromise<A, E>(effect: Effect.Effect<A, E, LabServices>): Promise<A> {
  return runLabPromise(effect, LiveLabLayer);
}
