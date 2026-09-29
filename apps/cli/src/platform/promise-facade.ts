import type { ChildProcess } from 'node:child_process';

import { Cause, type Duration, Effect, Exit, Layer, Logger } from 'effect';

import type { Logger as LodyLogger } from '@/utils/logger';

import { lodyLoggerLayer } from './logger';
import {
  isPidAlive,
  runCommand,
  runCommandOk,
  runCommandSync,
  runCommandSyncOk,
  type CommandOutput,
  type CommandSpec,
} from './process/command';
import { SpawnFailed } from './process/errors';
import {
  spawnProcess,
  type ManagedProcess,
  type ProcessExit,
  type SpawnSpec,
} from './process/managed-process';
import { NodeProcess, nodeProcessLive, type NodeProcessApi } from './process/node-process';
import type { TerminationPolicy } from './process/process-tree';

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

/** Facade options that swap only the spawn function, for callers with a spawn test seam. */
export const withSpawn = (
  spawnImpl: NodeProcessApi['spawn'] | undefined,
  options: Omit<PlatformFacadeOptions, 'nodeProcess'> = {}
): PlatformFacadeOptions =>
  spawnImpl ? { ...options, nodeProcess: { ...nodeProcessLive, spawn: spawnImpl } } : options;

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

/**
 * A spawn failure surfaces as the OS error itself (`code: 'ENOENT'`), as it did
 * before these callers moved onto the process layer.
 */
const unwrapSpawnFailure = (error: unknown): unknown =>
  error instanceof SpawnFailed && error.cause instanceof Error ? error.cause : error;

const runSyncSquashed = <A, E>(effect: Effect.Effect<A, E>): A => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

export interface CommandText {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

const toText = (output: CommandOutput): CommandText => ({
  code: output.code,
  signal: output.signal,
  stdout: output.stdout.toString('utf8'),
  stderr: output.stderr.toString('utf8'),
});

/**
 * TEMPORARY facade over `runCommand` / `runCommandOk` for Promise callers.
 * `check: 'exit-0'` rejects with `CommandFailed` on a non-zero exit, like
 * `execFile`; `check: 'none'` resolves with any exit status.
 */
export const runCommandText = async (
  spec: CommandSpec & { readonly check: 'exit-0' | 'none' },
  options: PlatformFacadeOptions = {}
): Promise<CommandText> => {
  const run = makePlatformRunner(options);
  try {
    return toText(await run(spec.check === 'exit-0' ? runCommandOk(spec) : runCommand(spec)));
  } catch (error) {
    throw unwrapSpawnFailure(error);
  }
};

/** TEMPORARY synchronous facade over `runCommandSync`; blocks the event loop. */
export const runCommandTextSync = (
  spec: CommandSpec & {
    readonly timeout: Duration.DurationInput;
    readonly check: 'exit-0' | 'none';
  },
  options: PlatformFacadeOptions = {}
): CommandText => {
  const effect = spec.check === 'exit-0' ? runCommandSyncOk(spec) : runCommandSync(spec);
  try {
    return toText(runSyncSquashed(Effect.provide(effect, platformLayer(options))));
  } catch (error) {
    throw unwrapSpawnFailure(error);
  }
};

export interface ProcessHandle {
  readonly child: ChildProcess;
  /** Resolves with the root's exit; never rejects. */
  readonly exited: Promise<ProcessExit>;
  /** Terminate the whole tree; rejects with `TerminationFailed` if it survives. */
  terminate(policy: TerminationPolicy): Promise<void>;
}

/**
 * TEMPORARY facade over `spawnProcess` for long-lived children owned by Promise
 * code. Synchronous like `spawn`: a start failure arrives on `child`'s `error`
 * event, and `exited` then resolves with nulls.
 */
export const startProcess = (
  spec: SpawnSpec,
  options: PlatformFacadeOptions = {}
): ProcessHandle => {
  let managed: ManagedProcess;
  try {
    managed = runSyncSquashed(Effect.provide(spawnProcess(spec), platformLayer(options)));
  } catch (error) {
    throw unwrapSpawnFailure(error);
  }
  const run = makePlatformRunner(options);
  return {
    child: managed.child,
    exited: runPromiseSquashed(managed.exited),
    terminate: (policy) => run(managed.terminate(policy)),
  };
};

/** TEMPORARY synchronous facade over `isPidAlive`. */
export const isPidAliveSync = (pid: number, options: PlatformFacadeOptions = {}): boolean =>
  runSyncSquashed(Effect.provide(isPidAlive(pid), platformLayer(options)));
