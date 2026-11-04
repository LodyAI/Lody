import { Deferred, Duration, Effect, Exit, HashMap, Option, Ref, Result, Scope } from 'effect';
import {
  terminateTree,
  type ManagedProcess,
  type ProcessTableEntry,
  type ProcessTree,
  type TerminationPolicy,
  type TerminationFailed,
} from '@lody/shared/node/process';

/** Retire an exited leader only after its whole group is proven empty. */
export const LINGERING_GROUP_PROBE_INTERVAL = Duration.seconds(5);

/**
 * Freeze-and-scan passes before a forced termination. Each pass stops the
 * groups found by the previous one, so only a group forked during the last
 * pass can be missed; real trees settle within two.
 */
const MAX_ESCAPE_SCANS = 4;

/**
 * How a container without a kernel boundary reaches the groups that tracked
 * processes' descendants moved into (setsid). Claude Code starts every Bash
 * tool shell that way, so signalling the agent's own group never reaches them.
 */
export interface EscapedGroupDiscovery {
  readonly listProcesses: () => readonly ProcessTableEntry[] | null;
  readonly groupTree: (pgid: number) => ProcessTree;
  /** The owning daemon: its group, and pid 1's, are never adopted. */
  readonly ownPid: number;
}

/**
 * Groups of descendants of `groups`' members that lead or joined another
 * group, transitively. Members of an adopted group count as descendants too:
 * a command can outlive the shell that started it. The scan must run while
 * the parent links still exist; once a parent dies its children belong to
 * pid 1 and nothing ties them to the session.
 */
export const findEscapedGroups = (
  table: readonly ProcessTableEntry[],
  groups: ReadonlySet<number>,
  ownPid: number
): number[] => {
  const ownGroup = table.find((entry) => entry.pid === ownPid)?.pgid;
  const never = new Set([0, 1, ownPid, ...(ownGroup === undefined ? [] : [ownGroup])]);
  const children = new Map<number, ProcessTableEntry[]>();
  for (const entry of table) {
    if (entry.zombie) continue;
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else children.set(entry.ppid, [entry]);
  }
  const known = new Set(groups);
  const found: number[] = [];
  const queue = table.filter((entry) => known.has(entry.pgid)).map((entry) => entry.pid);
  const seen = new Set(queue);
  const visit = (pid: number) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    queue.push(pid);
  };
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (never.has(child.pgid) || never.has(child.pid)) continue;
      if (!known.has(child.pgid)) {
        known.add(child.pgid);
        found.push(child.pgid);
        for (const member of table) if (member.pgid === child.pgid) visit(member.pid);
      }
      visit(child.pid);
    }
  }
  return found;
};

/** Containers retain failed trees independently of the acquisition Scope. */
export const makeProcessTreeRegistry = Effect.fnUntraced(function* (
  escapedGroups?: EscapedGroupDiscovery
) {
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
  const freeze = (trees: Iterable<ProcessTree>) =>
    Effect.forEach(trees, (tree) => Effect.ignore(tree.signal('SIGSTOP')), {
      concurrency: 'unbounded',
      discard: true,
    });
  /**
   * Track the groups descendants escaped into, so termination ends them with
   * the rest and keeps them until proven gone. A forced termination stops
   * every group first: a frozen tree cannot fork past the scan, and SIGKILL
   * still ends stopped processes. A graceful one only scans: stopped
   * processes would ignore SIGTERM and the agent could not clean up.
   */
  const adoptEscapedGroups = (discovery: EscapedGroupDiscovery, forced: boolean) =>
    Effect.gen(function* () {
      let frontier: Iterable<ProcessTree> = HashMap.values(yield* Ref.get(tracked));
      for (let scan = 0; scan < MAX_ESCAPE_SCANS; scan++) {
        if (forced) yield* freeze(frontier);
        const table = yield* Effect.try({
          try: () => discovery.listProcesses(),
          catch: (cause) => cause,
        }).pipe(
          // Degrade to ending the tracked groups alone; termination itself
          // still proves those gone.
          Effect.catch((cause) =>
            Effect.as(
              Effect.logWarning(
                `Could not list processes to find escaped descendants: ${String(cause)}`
              ),
              null
            )
          )
        );
        if (table === null) return;
        const groups = new Set(HashMap.keys(yield* Ref.get(tracked)));
        const found = findEscapedGroups(table, groups, discovery.ownPid);
        if (found.length === 0) return;
        const adopted = found.map((pgid) => [pgid, discovery.groupTree(pgid)] as const);
        yield* Ref.update(tracked, (trees) =>
          adopted.reduce((next, [pgid, tree]) => HashMap.set(next, pgid, tree), trees)
        );
        if (!forced) return;
        frontier = adopted.map(([, tree]) => tree);
      }
    });
  return {
    track: (managed: ManagedProcess) =>
      Effect.gen(function* () {
        const pid = managed.child.pid;
        if (typeof pid !== 'number' || pid <= 0)
          return (_processScope: Scope.Closeable) => Effect.void;
        const gone = yield* Deferred.make<void>();
        yield* Ref.update(tracked, HashMap.set(pid, managed.tree));
        yield* managed.exited.pipe(
          Effect.andThen(forgetWhenGone(pid, managed.tree)),
          Effect.andThen(Deferred.succeed(gone, undefined)),
          Effect.forkIn(scope)
        );
        // Start only after configuration succeeds. Closing earlier could race
        // with cgroup attachment or a caller waiting to receive the handle.
        const closed = managed.closed;
        return (processScope: Scope.Closeable) =>
          Deferred.await(gone).pipe(
            Effect.andThen(closed),
            Effect.andThen(Scope.close(processScope, Exit.void)),
            Effect.forkIn(scope),
            Effect.asVoid
          );
      }),
    rootPids: Effect.map(Ref.get(tracked), (trees) => Array.from(HashMap.keys(trees))),
    captureEscapedProcesses: (forced: boolean) =>
      escapedGroups ? adoptEscapedGroups(escapedGroups, forced) : Effect.void,
    terminateAll: (policy: TerminationPolicy) =>
      Effect.gen(function* () {
        if (escapedGroups) yield* adoptEscapedGroups(escapedGroups, policy.graceMs === 0);
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
