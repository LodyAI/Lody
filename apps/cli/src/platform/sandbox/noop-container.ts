import { Duration, Effect, Result, HashMap, Option, Ref, Scope, Exit } from 'effect';
import { ChildProcessSpawner } from 'effect/process';

import { SpawnFailed, type TerminationFailed } from '@lody/shared/node/process';
import { spawnProcess } from '@lody/shared/node/process';
import { terminateTree, type ProcessTree } from '@lody/shared/node/process';

import { FORCED_TERMINATION, type ProcessContainer } from './types';

/**
 * How often a process group whose leader already exited is re-checked. The
 * group id cannot be reused while any member lives; the probe drops the entry
 * soon after the last one exits, so a later tree kill cannot reach a stranger
 * that happened to get the same id.
 */
export const LINGERING_GROUP_PROBE_INTERVAL = Duration.seconds(5);

/**
 * A container without hard limits: each process leads its own group (POSIX)
 * or tree (Windows), and the container remembers every one of them until it
 * is proven empty, including groups whose leader exited first.
 */
export const makeNoopContainer = (options: {
  readonly description: string;
  readonly configureProcess: (pid: number) => Effect.Effect<void>;
}): Effect.Effect<ProcessContainer, never, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Effect.scope;
    const tracked = yield* Ref.make(HashMap.empty<number, ProcessTree>());

    const forget = (pid: number, tree: ProcessTree) =>
      Ref.update(tracked, (trees) =>
        Option.exists(HashMap.get(trees, pid), (current) => current === tree)
          ? HashMap.remove(trees, pid)
          : trees
      );

    const forgetWhenGone = (pid: number, tree: ProcessTree): Effect.Effect<void> => {
      const probe: Effect.Effect<void> = tree.isAlive.pipe(
        // A probe that cannot run cannot keep the entry honest either.
        Effect.catch(() => Effect.succeed(false)),
        Effect.flatMap((alive) =>
          alive
            ? Effect.andThen(
                Effect.sleep(LINGERING_GROUP_PROBE_INTERVAL),
                Effect.suspend(() => probe)
              )
            : forget(pid, tree)
        )
      );
      return probe;
    };

    const container: ProcessContainer = {
      enabled: false,
      description: options.description,
      spawn: (spec) =>
        Effect.suspend(() =>
          scope.state._tag === 'Closed'
            ? Effect.fail(
                new SpawnFailed({
                  command: spec.command,
                  message: 'The process container is closed',
                  cause: null,
                })
              )
            : Effect.acquireUseRelease(
                Scope.fork(scope),
                (childScope) =>
                  Scope.provide(
                    Effect.gen(function* () {
                      const managed = yield* spawnProcess({ ...spec, processGroup: true }).pipe(
                        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
                      );
                      const pid = managed.child.pid;
                      if (typeof pid === 'number' && pid > 0) {
                        yield* Ref.update(tracked, HashMap.set(pid, managed.tree));
                        yield* managed.exited.pipe(
                          Effect.andThen(forgetWhenGone(pid, managed.tree)),
                          Effect.forkIn(scope)
                        );
                        yield* options.configureProcess(pid);
                      }
                      return { ...managed, inspectExit: () => Effect.succeed(null) };
                    }),
                    childScope
                  ),
                (childScope, exit) =>
                  Exit.isFailure(exit) ? Scope.close(childScope, exit) : Effect.void
              )
        ),
      terminateAll: (policy) =>
        Effect.gen(function* () {
          const trees = Array.from(HashMap.values(yield* Ref.get(tracked)));
          const results = yield* Effect.forEach(
            trees,
            (tree) => Effect.result(terminateTree(tree, policy)),
            { concurrency: 'unbounded' }
          );
          const failure = results.find(Result.isFailure);
          if (failure) {
            yield* Effect.fail<TerminationFailed>(failure.failure);
          }
        }),
      applyLimits: () => Effect.void,
      readAccounting: Effect.map(Ref.get(tracked), (trees) => ({
        kind: 'process-tree' as const,
        rootPids: Array.from(HashMap.keys(trees)),
        memoryLimitBytes: null,
        cpuLimitCores: null,
        pidsLimit: null,
      })),
      cleanup: Effect.suspend(() =>
        container.terminateAll(FORCED_TERMINATION).pipe(
          Effect.catch((error) => Effect.logWarning(error.message)),
          Effect.andThen(Ref.set(tracked, HashMap.empty()))
        )
      ),
    };
    yield* Effect.addFinalizer(() => container.cleanup);
    return container;
  });
