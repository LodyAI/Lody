import { afterEach, expect, it } from 'vitest';
import { Effect } from 'effect';
import type { ProcessTree } from '@lody/shared/node/process';
import {
  configureManagedProcessObservation,
  observeManagedProcessTree,
  confirmManagedProcessTreesGone,
  pruneManagedProcessTrees,
} from './managed-process-observation';
import {
  reserveMachineTurn,
  pauseMachineTurnsIfIdle,
  resumeMachineTurns,
} from '@/session/machine-turn-admission';
afterEach(async () => {
  configureManagedProcessObservation(false);
  resumeMachineTurns();
  await Effect.runPromise(pruneManagedProcessTrees());
});
it('an idle update cannot race initialization in another workspace or admit new turns after it pauses', () => {
  const workspaceTurn = reserveMachineTurn();
  expect(workspaceTurn).not.toBeNull();
  expect(pauseMachineTurnsIfIdle()).toBe(false);
  workspaceTurn?.();
  expect(pauseMachineTurnsIfIdle()).toBe(true);
  expect(reserveMachineTurn()).toBeNull();
  resumeMachineTurns();
  const next = reserveMachineTurn();
  expect(next).not.toBeNull();
  next?.();
});
it('a managed drain joins observed groups instead of trusting the root process exit', async () => {
  configureManagedProcessObservation(true);
  let alive = true;
  const tree: ProcessTree = {
    description: 'synthetic orphaned ACP group',
    isAlive: Effect.sync(() => alive),
    signal: () =>
      Effect.sync(() => {
        alive = false;
        return 'delivered' as const;
      }),
  };
  observeManagedProcessTree(tree);
  await Effect.runPromise(confirmManagedProcessTreesGone);
  expect(alive).toBe(false);
});
it('an unknown descendant liveness result cannot become a successful update drain', async () => {
  configureManagedProcessObservation(true);
  let unknown = true;
  const tree: ProcessTree = {
    description: 'unconfirmed owned group',
    isAlive: Effect.suspend(() =>
      unknown ? Effect.die(new Error('ownership probe failed')) : Effect.succeed(false)
    ),
    signal: () => Effect.succeed('gone' as const),
  };
  observeManagedProcessTree(tree);
  try {
    await expect(Effect.runPromise(confirmManagedProcessTreesGone)).rejects.toThrow(
      /ownership probe failed/
    );
  } finally {
    unknown = false;
    await Effect.runPromise(pruneManagedProcessTrees());
  }
});
