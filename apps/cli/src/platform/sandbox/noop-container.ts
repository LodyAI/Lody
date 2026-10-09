import { Effect, Scope, Exit } from 'effect';
import { ChildProcessSpawner } from 'effect/process';

import { SpawnFailed } from '@lody/shared/node/process';
import { spawnProcess } from '@lody/shared/node/process';

import { FORCED_TERMINATION, type ProcessContainer } from './types';

import { makeProcessTreeRegistry } from './process-tree-registry';
export { LINGERING_GROUP_PROBE_INTERVAL } from './process-tree-registry';

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
    const registry = yield* makeProcessTreeRegistry;

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
                        yield* registry.track(managed);
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
      terminateAll: registry.terminateAll,
      applyLimits: () => Effect.void,
      readAccounting: Effect.map(registry.rootPids, (rootPids) => ({
        kind: 'process-tree' as const,
        rootPids,
        memoryLimitBytes: null,
        cpuLimitCores: null,
        pidsLimit: null,
      })),
      cleanup: Effect.suspend(() =>
        container
          .terminateAll(FORCED_TERMINATION)
          .pipe(Effect.catch((error) => Effect.logWarning(error.message)))
      ),
    };
    yield* Effect.addFinalizer(() => container.cleanup);
    return container;
  });
