import { Cause, Effect, Exit, Layer, Logger } from 'effect';

import type { Logger as LodyLogger } from '@/utils/logger';

import { lodyLoggerLayer } from './logger';
import { NodeProcess, nodeProcessLive, type NodeProcessApi } from './process/node-process';

/**
 * TEMPORARY: the door from Promise code to Effect services that it has not
 * been migrated onto yet. Each caller is an upper layer that will become an
 * Effect itself and then provide these services through its own Layer; see
 * `.agents/docs/cli-effect-ts.md#temporary-promise-facades`.
 *
 * Failures reject with the typed error itself (`Cause.squash`), not a
 * `FiberFailure` wrapper, so `instanceof` and `error.message` keep working for
 * Promise callers.
 */
export interface PlatformFacadeOptions {
  readonly logger?: LodyLogger;
  readonly nodeProcess?: NodeProcessApi;
}

export type PlatformRunner = <A, E>(effect: Effect.Effect<A, E, NodeProcess>) => Promise<A>;

export const platformLayer = (options: PlatformFacadeOptions): Layer.Layer<NodeProcess> =>
  Layer.merge(
    Layer.succeed(NodeProcess, options.nodeProcess ?? nodeProcessLive),
    options.logger
      ? lodyLoggerLayer(options.logger)
      : Logger.replace(Logger.defaultLogger, Logger.none)
  );

export const makePlatformRunner = (options: PlatformFacadeOptions): PlatformRunner => {
  const layer = platformLayer(options);
  return (effect) => runPromiseSquashed(Effect.provide(effect, layer));
};

export const runPromiseSquashed = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
  });
