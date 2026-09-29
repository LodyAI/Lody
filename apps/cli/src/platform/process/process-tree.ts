import type { ChildProcess } from 'node:child_process';

import { Duration, Effect, Either } from 'effect';

import { formatErrorMessage } from '@/utils/format-error';

import { TerminationFailed } from './errors';
import { errnoCode, NodeProcess, type NodeProcessApi } from './node-process';

export type TreeSignal = 'SIGTERM' | 'SIGKILL';

/** `gone`: nothing was left to signal, which is as good as a completed kill. */
export type SignalOutcome = 'delivered' | 'gone';

/**
 * A set of OS processes that live and die together: a POSIX process group, a
 * Windows process tree rooted at one pid, a cgroup, or a lone child.
 *
 * `isAlive` must answer for the whole set, not just its root. That is what lets
 * termination keep going after the root exits while its descendants run on.
 */
export interface ProcessTree {
  readonly description: string;
  readonly isAlive: Effect.Effect<boolean, TerminationFailed>;
  readonly signal: (signal: TreeSignal) => Effect.Effect<SignalOutcome, TerminationFailed>;
}

/**
 * `graceMs` is the SIGTERM window; 0 sends SIGKILL immediately. `killWaitMs`
 * bounds the wait after SIGKILL: every wait is bounded, so a tree that cannot
 * be killed surfaces as `TerminationFailed` instead of hanging its caller.
 */
export interface TerminationPolicy {
  readonly graceMs: number;
  readonly killWaitMs: number;
}

export const TREE_POLL_INTERVAL = Duration.millis(20);
export const TASKKILL_DEADLINE = Duration.seconds(10);
/** taskkill exit status when no process matched the pid. */
const TASKKILL_NOT_FOUND = 128;

export const hasExited = (child: ChildProcess): boolean =>
  (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null;

const hasPid = (child: ChildProcess): child is ChildProcess & { pid: number } =>
  typeof child.pid === 'number' && child.pid > 0;

const signalFailed = (target: string, signal: TreeSignal | 0, cause: unknown) =>
  new TerminationFailed({
    target,
    reason: 'signal-failed',
    message: `Failed to send ${signal === 0 ? 'liveness probe' : signal} to ${target}: ${formatErrorMessage(cause)}`,
    cause,
  });

/**
 * Every member of the group started by a `detached` spawn. The group outlives
 * its leader, so this is how orphaned grandchildren (an MCP server under an
 * exited npx wrapper) stay reachable.
 */
export const posixGroupTree = (np: NodeProcessApi, pgid: number): ProcessTree => {
  const description = `process group ${pgid}`;
  const kill = (signal: TreeSignal | 0) =>
    Effect.try({
      try: () => np.kill(-pgid, signal),
      catch: (cause) => cause,
    });
  return {
    description,
    isAlive: kill(0).pipe(
      Effect.as(true),
      Effect.catchAll((cause) => {
        const code = errnoCode(cause);
        if (code === 'ESRCH') return Effect.succeed(false);
        // EPERM: the group exists but is not ours to signal; it is still alive.
        if (code === 'EPERM') return Effect.succeed(true);
        return Effect.fail(signalFailed(description, 0, cause));
      })
    ),
    signal: (signal) =>
      kill(signal).pipe(
        Effect.as<SignalOutcome>('delivered'),
        Effect.catchAll((cause) =>
          errnoCode(cause) === 'ESRCH'
            ? Effect.succeed<SignalOutcome>('gone')
            : Effect.fail(signalFailed(description, signal, cause))
        )
      ),
  };
};

/**
 * A process with no group of its own; only the root can be reached. A child
 * that never started reads as alive until signalled, where `kill()` reporting
 * no delivery settles it as gone.
 */
export const childTree = (child: ChildProcess): ProcessTree => {
  const description = `process ${child.pid ?? '(not started)'}`;
  return {
    description,
    isAlive: Effect.sync(() => !hasExited(child)),
    signal: (signal) =>
      Effect.try({
        try: () => child.kill(signal),
        catch: (cause) => cause,
      }).pipe(
        Effect.map((delivered): SignalOutcome => (delivered ? 'delivered' : 'gone')),
        Effect.catchAll((cause) =>
          errnoCode(cause) === 'ESRCH'
            ? Effect.succeed<SignalOutcome>('gone')
            : Effect.fail(signalFailed(description, signal, cause))
        )
      ),
  };
};

/**
 * Spawn taskkill and subscribe in the same synchronous step: attaching after
 * a fiber yield could miss the `close` of a taskkill that finished first.
 * Interruption (the deadline) kills a taskkill that is still running.
 */
const runTaskkill = (np: NodeProcessApi, args: readonly string[]) =>
  Effect.async<number | null, unknown>((resume) => {
    let taskkill: ChildProcess;
    try {
      taskkill = np.spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
    } catch (cause) {
      resume(Effect.fail(cause));
      return Effect.void;
    }
    const onClose = (code: number | null) => resume(Effect.succeed(code));
    const onError = (error: Error) => resume(Effect.fail(error));
    taskkill.once('close', onClose);
    taskkill.once('error', onError);
    return Effect.sync(() => {
      taskkill.off('close', onClose);
      taskkill.off('error', onError);
      if (!hasExited(taskkill)) taskkill.kill();
    });
  });

/**
 * `taskkill /T` walks the tree from the root at call time. A descendant whose
 * parent already exited is no longer reachable from it; only a Job Object
 * could contain that case, and this tree does not claim to.
 */
export const windowsTree = (
  np: NodeProcessApi,
  root: ChildProcess & { pid: number }
): ProcessTree => {
  const description = `process tree ${root.pid}`;
  return {
    description,
    isAlive: Effect.sync(() => !hasExited(root)),
    signal: (signal) =>
      Effect.gen(function* () {
        const force = signal === 'SIGKILL';
        const code = yield* runTaskkill(np, [
          '/PID',
          String(root.pid),
          '/T',
          ...(force ? ['/F'] : []),
        ]).pipe(
          Effect.mapError((cause) => signalFailed(description, signal, cause)),
          Effect.timeoutFail({
            duration: TASKKILL_DEADLINE,
            onTimeout: () =>
              signalFailed(
                description,
                signal,
                new Error(`taskkill did not finish within ${Duration.format(TASKKILL_DEADLINE)}`)
              ),
          })
        );
        if (code === 0) return 'delivered' as const;
        if (code === TASKKILL_NOT_FOUND) return 'gone' as const;
        return yield* Effect.fail(
          signalFailed(description, signal, new Error(`taskkill exited with status ${code}`))
        );
      }),
  };
};

/**
 * The tree a spawned child heads. `processGroup` must match how the child was
 * spawned: only a `detached` POSIX spawn leads its own group.
 */
export const childProcessTree = (
  child: ChildProcess,
  options: { readonly processGroup: boolean }
): Effect.Effect<ProcessTree, never, NodeProcess> =>
  Effect.map(NodeProcess, (np) => {
    if (!hasPid(child)) return childTree(child);
    if (np.platform === 'win32') return windowsTree(np, child);
    return options.processGroup ? posixGroupTree(np, child.pid) : childTree(child);
  });

/** Poll until the whole tree is gone. `false` means it outlived `within`. */
export const waitUntilGone = (
  tree: ProcessTree,
  within: Duration.DurationInput
): Effect.Effect<boolean, TerminationFailed> => {
  const poll: Effect.Effect<boolean, TerminationFailed> = Effect.flatMap(tree.isAlive, (alive) =>
    alive
      ? Effect.zipRight(
          Effect.sleep(TREE_POLL_INTERVAL),
          Effect.suspend(() => poll)
        )
      : Effect.succeed(true)
  );
  return Effect.timeoutTo(poll, {
    duration: within,
    onSuccess: (gone) => gone,
    onTimeout: () => false,
  });
};

/**
 * SIGTERM, bounded grace, SIGKILL, bounded wait. Succeeds only once the whole
 * tree is proven gone; otherwise fails with `TerminationFailed`.
 */
export const terminateTree = (
  tree: ProcessTree,
  policy: TerminationPolicy
): Effect.Effect<void, TerminationFailed> =>
  Effect.gen(function* () {
    if (!(yield* tree.isAlive)) return;

    if (policy.graceMs > 0) {
      const graceful = yield* Effect.either(tree.signal('SIGTERM'));
      if (Either.isRight(graceful)) {
        if (graceful.right === 'gone') return;
        if (yield* waitUntilGone(tree, Duration.millis(policy.graceMs))) return;
        yield* Effect.logDebug(
          `${tree.description} still running ${policy.graceMs}ms after SIGTERM; escalating to SIGKILL`
        );
      } else {
        // A tree that cannot take SIGTERM (a Windows console app refusing a
        // graceful taskkill) gains nothing from waiting out the grace period.
        yield* Effect.logDebug(
          `SIGTERM was not delivered to ${tree.description}; escalating to SIGKILL: ${graceful.left.message}`
        );
      }
    }

    if ((yield* tree.signal('SIGKILL')) === 'gone') return;
    if (yield* waitUntilGone(tree, Duration.millis(policy.killWaitMs))) return;
    yield* Effect.fail(
      new TerminationFailed({
        target: tree.description,
        reason: 'still-alive',
        message: `${tree.description} was still running ${policy.killWaitMs}ms after SIGKILL`,
      })
    );
  });
