import { Duration, Effect, HashMap, Option, Ref, Result } from 'effect';
import {
  terminateTree,
  type ManagedProcess,
  type ProcessTree,
  type TerminationPolicy,
  type TerminationFailed,
} from '@lody/shared/node/process';

/** Retire an exited leader only after its whole group is proven empty. */
export const LINGERING_GROUP_PROBE_INTERVAL = Duration.seconds(5);

/** Containers retain failed trees independently of the acquisition Scope. */
export const makeProcessTreeRegistry = Effect.gen(function* () {
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
      // A failed probe does not prove absence. Keep the tree and retry.
      Effect.catch((error) => Effect.as(Effect.logWarning(error.message), true)),
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
  return {
    track: (managed: ManagedProcess) =>
      Effect.gen(function* () {
        const pid = managed.child.pid;
        if (typeof pid !== 'number' || pid <= 0) return;
        yield* Ref.update(tracked, HashMap.set(pid, managed.tree));
        yield* managed.exited.pipe(
          Effect.andThen(forgetWhenGone(pid, managed.tree)),
          Effect.forkIn(scope)
        );
      }),
    rootPids: Effect.map(Ref.get(tracked), (trees) => Array.from(HashMap.keys(trees))),
    terminateAll: (policy: TerminationPolicy) =>
      Effect.gen(function* () {
        const entries = Array.from(yield* Ref.get(tracked));
        const outcomes = yield* Effect.forEach(
          entries,
          ([pid, tree]) =>
            terminateTree(tree, policy).pipe(Effect.andThen(forget(pid, tree)), Effect.result),
          { concurrency: 'unbounded' }
        );
        const failure = outcomes.find(Result.isFailure);
        if (failure) yield* Effect.fail<TerminationFailed>(failure.failure);
      }),
  };
});
