import { Effect } from 'effect';
import { terminateTree, type ProcessTree } from '@lody/shared/node/process';
// Borrowed by the existing Promise composition boundary. Native process effects
// are executed only by start.ts; observation never blocks ordinary process spawn.
const launch = Object.freeze({
  protocol: process.env.LODY_MANAGED_DAEMON_PROTOCOL === '1',
  candidate: process.env.LODY_MANAGED_CANDIDATE === '1',
});
delete process.env.LODY_MANAGED_DAEMON_PROTOCOL;
delete process.env.LODY_MANAGED_CANDIDATE;
export function getManagedWorkerLaunchContext() {
  return launch;
}
let enabled = false;
let overflow = false;
const trees = new Set<ProcessTree>();
const MAX_OBSERVED_TREES = 5000;
export function configureManagedProcessObservation(value: boolean): void {
  enabled = value;
}
export function observeManagedProcessTree(tree: ProcessTree): void {
  if (!enabled) return;
  if (trees.size >= MAX_OBSERVED_TREES) {
    overflow = true;
    return;
  }
  trees.add(tree);
}
export const pruneManagedProcessTrees = Effect.fn('pruneManagedProcessTrees')(function* () {
  for (const tree of [...trees]) {
    if (!(yield* tree.isAlive)) trees.delete(tree);
  }
});
/** A clean Worker exit must not conceal detached owned groups left by failed cleanup. */
export const confirmManagedProcessTreesGone = Effect.gen(function* () {
  if (overflow)
    return yield* Effect.fail(new Error('Managed process ownership inventory is incomplete'));
  for (const tree of [...trees]) {
    if (yield* tree.isAlive) yield* terminateTree(tree, { graceMs: 2000, killWaitMs: 5000 });
    if (yield* tree.isAlive)
      return yield* Effect.fail(new Error('Managed subprocess termination is unconfirmed'));
    trees.delete(tree);
  }
});
