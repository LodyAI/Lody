import { Cause, Effect, Exit, type Layer } from 'effect';
import { LiveLabLayer, type LabServices } from './live';

/** Promise boundary: provide a layer then unwrap failures as thrown values. */
export async function runLabPromise<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R, never, never>
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(layer)));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** Default Live adapters for AttackLab / attack helpers. */
export async function runLiveLabPromise<A, E>(
  effect: Effect.Effect<A, E, LabServices>
): Promise<A> {
  return runLabPromise(effect, LiveLabLayer);
}
