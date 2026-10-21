import { Effect } from 'effect';
import type { BlockedInboxExecution } from './recovery';

export type InboxOperatorRecoveryPorts = {
  blocked: Effect.Effect<BlockedInboxExecution[], unknown>;
  exclusive<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E | unknown, R>;
  knownResourcesGone(record: BlockedInboxExecution): Effect.Effect<boolean, unknown>;
  confirm(record: BlockedInboxExecution): Effect.Effect<boolean, unknown>;
};

/** Explicit operator attestation covers missing journal data; it never proves automatic release. */
export const recoverBlockedInboxExecution = Effect.fn('Inbox.operatorRecovery')(function* (
  ports: InboxOperatorRecoveryPorts,
  sessionId: string,
  executionId: string | null,
  confirmed: boolean,
  snapshotToken?: string
) {
  if (!confirmed)
    return yield* Effect.fail(
      new Error('Explicit confirmation of all released resources is required')
    );
  return yield* ports.exclusive(
    Effect.gen(function* () {
      const record = (yield* ports.blocked).find(
        (entry) => entry.scope.sessionId === sessionId && entry.executionId === executionId
      );
      if (!record)
        return yield* Effect.fail(
          new Error('The specified Inbox is no longer blocked; inspect again')
        );
      if (record.reason === 'ambiguous_ownership')
        return yield* Effect.fail(
          new Error('Multiple execution owners remain; recovery requires investigation')
        );
      if (
        (executionId === null && !snapshotToken) ||
        (snapshotToken !== undefined && snapshotToken !== record.snapshotToken)
      )
        return yield* Effect.fail(new Error('Blocked Inbox snapshot changed; inspect again'));
      if (!(yield* ports.knownResourcesGone(record)))
        return yield* Effect.fail(
          new Error('Known resources are still running or cannot be verified')
        );
      if (!(yield* ports.confirm(record)))
        return yield* Effect.fail(new Error('Blocked execution changed during recovery'));
      return {
        recovered: true,
        executionId,
        paused: true,
        nextAction:
          'Restart Lody. Fresh human or Agent-chat input clears the pause; unknown old requests are not replayed. Queued input and saved results are preserved.',
      };
    })
  );
});
