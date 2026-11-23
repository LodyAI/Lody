import { Effect } from 'effect';
import { makeWorkspaceCleanupOwner } from './workspace-cleanup-owner';

/** Fleet entry bridge; Lody/scheduler/poller cleanup are registered upstream adapters. */
export const workspaceCleanupOwnerLegacy = (phases: readonly (() => Promise<void>)[]) => {
  const owner = Effect.runSync(
    makeWorkspaceCleanupOwner(
      phases.map((phase) => Effect.tryPromise({ try: phase, catch: (cause) => cause }))
    )
  );
  return {
    run: () => Effect.runPromise(owner.close),
    retry: () => Effect.runPromise(owner.recover),
    causes: owner.failures,
  };
};
