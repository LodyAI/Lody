import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { Deferred, Effect, type Scope } from 'effect';

import { formatErrorMessage } from '@/utils/format-error';

import { SpawnFailed, type TerminationFailed } from './errors';
import { NodeProcess } from './node-process';
import {
  childProcessTree,
  terminateTree,
  type ProcessTree,
  type TerminationPolicy,
} from './process-tree';

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  /**
   * Start the child as the leader of its own POSIX process group so the whole
   * subtree can be signalled. Ignored on Windows, where the tree is walked
   * from the root pid instead.
   */
  readonly processGroup: boolean;
  /**
   * Runs synchronously right after the OS call, before any asynchronous
   * post-spawn step. Anything that must observe the child's first stdio or
   * lifecycle event (output capture, event replay) attaches here.
   */
  readonly onSpawned?: (child: ChildProcess) => void;
}

export interface ManagedProcess {
  readonly child: ChildProcess;
  readonly tree: ProcessTree;
  /** The root's pid once the OS confirms the start, or the spawn error. */
  readonly started: Effect.Effect<number, SpawnFailed>;
  /** The root's exit. A child that never started completes with nulls. */
  readonly exited: Effect.Effect<ProcessExit>;
  /**
   * Terminate the whole tree under `policy`. Concurrent calls each converge
   * on "gone": a forced call during a graceful one escalates at once instead
   * of waiting out the grace period, and a call after a successful one
   * returns immediately because nothing is left alive.
   */
  readonly terminate: (policy: TerminationPolicy) => Effect.Effect<void, TerminationFailed>;
}

/**
 * Spawn a process whose termination the caller owns. Prefer `spawnScoped`;
 * this form exists for owners whose lifetime is not yet an Effect scope.
 */
export const spawnProcess = (
  spec: SpawnSpec
): Effect.Effect<ManagedProcess, SpawnFailed, NodeProcess> =>
  Effect.gen(function* () {
    const np = yield* NodeProcess;
    const processGroup = spec.processGroup && np.platform !== 'win32';
    const exited = yield* Deferred.make<ProcessExit>();
    const started = yield* Deferred.make<number, SpawnFailed>();
    const spawnFailed = (cause: unknown) =>
      new SpawnFailed({
        command: spec.command,
        message: `Failed to spawn ${spec.command}: ${formatErrorMessage(cause)}`,
        cause,
      });
    const child = yield* Effect.try({
      try: () => {
        const spawned = np.spawn(spec.command, spec.args, {
          // The daemon runs without a console on Windows; without
          // CREATE_NO_WINDOW every console child pops a window and steals focus.
          windowsHide: true,
          ...spec.options,
          detached: processGroup,
        });
        // Subscribe before anything can yield: Node reports a failed spawn on
        // the next tick, and a listener attached later would never hear it.
        if (typeof spawned.pid === 'number' && spawned.pid > 0) {
          Deferred.unsafeDone(started, Effect.succeed(spawned.pid));
        }
        spawned.once('spawn', () => {
          if (typeof spawned.pid === 'number' && spawned.pid > 0) {
            Deferred.unsafeDone(started, Effect.succeed(spawned.pid));
          }
        });
        spawned.once('exit', (code, signal) => {
          Deferred.unsafeDone(exited, Effect.succeed({ code, signal }));
        });
        spawned.once('error', (error) => {
          // A spawn failure has no exit event; release anyone awaiting one.
          if (typeof spawned.pid !== 'number') {
            Deferred.unsafeDone(started, Effect.fail(spawnFailed(error)));
            Deferred.unsafeDone(exited, Effect.succeed({ code: null, signal: null }));
          }
        });
        spec.onSpawned?.(spawned);
        return spawned;
      },
      catch: spawnFailed,
    });
    const tree = yield* childProcessTree(child, { processGroup });
    return {
      child,
      tree,
      started: Deferred.await(started),
      exited: Deferred.await(exited),
      terminate: (policy) => terminateTree(tree, policy),
    } satisfies ManagedProcess;
  });

/**
 * Spawn a process owned by the current scope: closing the scope terminates
 * its whole tree under `releasePolicy`. A release that cannot prove the tree
 * gone is logged, because a finalizer cannot fail.
 */
export const spawnScoped = (
  spec: SpawnSpec,
  releasePolicy: TerminationPolicy
): Effect.Effect<ManagedProcess, SpawnFailed, NodeProcess | Scope.Scope> =>
  Effect.acquireRelease(spawnProcess(spec), (managed) =>
    managed
      .terminate(releasePolicy)
      .pipe(
        Effect.catchAll((error) =>
          Effect.logWarning(`Scope release could not terminate ${error.target}: ${error.message}`)
        )
      )
  );
