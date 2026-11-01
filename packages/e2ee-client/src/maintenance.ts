import { Effect, Result } from 'effect';
import {
  KeyDistributor,
  KeyReceiver,
  KeyRepair,
  MailboxInstallError,
  runWorkspaceKeyRound,
  type WorkspaceKeyRoundCursors,
} from '@lody/e2ee-core';

/** Workspace-owned paging hints. Originals and retry evidence remain in core journals. */
export const makePersonalKeyMaintenance = Effect.fnUntraced(function* () {
  const repair = yield* KeyRepair;
  const receiver = yield* KeyReceiver;
  const distributor = yield* KeyDistributor;
  let cursors: WorkspaceKeyRoundCursors = {};
  let epoch: number | undefined;
  return Effect.fnUntraced(function* (
    currentEpoch: number,
    beforeReceive?: Effect.Effect<unknown, unknown>
  ) {
    if (epoch !== currentEpoch) {
      cursors = {};
      epoch = currentEpoch;
    }
    let refreshRequired = false;
    // A refresh performs finite work even if a server keeps returning hostile pages.
    for (let step = 0; step < 4; step++) {
      const result = yield* runWorkspaceKeyRound(100, cursors, beforeReceive).pipe(
        Effect.provideService(KeyRepair, repair),
        Effect.provideService(KeyReceiver, receiver),
        Effect.provideService(KeyDistributor, distributor),
        Effect.catchTag('WorkspaceKeyRoundFailure', (failure) =>
          Effect.gen(function* () {
            cursors = failure.cursors;
            // Observe the successful sibling even while the failed phase remains retryable.
            if (Result.isSuccess(failure.receive)) {
              refreshRequired ||= failure.receive.success.refreshRequired;
              for (const item of failure.receive.success.results)
                yield* receiver.acknowledge(item.id);
              for (const item of failure.receive.success.repairResults.items)
                yield* repair.acknowledge(item.id);
            }
            if (Result.isSuccess(failure.distribution)) {
              for (const item of failure.distribution.success.deliveryResults.items)
                yield* distributor.acknowledge(item.id);
            }
            const error = Result.isFailure(failure.receive) ? failure.receive.failure : undefined;
            // Local I/O/signing failures never authorize rejection of authentic bytes.
            if (!(error instanceof MailboxInstallError) || !error.cryptographicRejection)
              return yield* failure;
            const { id } = yield* repair.enqueue(
              `rejected:${error.epoch}:${error.frameDigest}`,
              error.frameDigest
            );
            const flushed = yield* repair.flush();
            if (flushed.blocked.includes(id)) return yield* failure;
            if (
              Result.isFailure(failure.distribution) ||
              Result.isFailure(failure.reportsAfterSend)
            )
              return yield* failure;
            // Never advance a failed page. The backend now excludes this exact digest.
            return undefined;
          })
        )
      );
      if (!result) continue;
      refreshRequired ||= result.refreshRequired;
      // The host has observed each terminal business result. ACK does not erase
      // originals, change authority or establish possession of a recipient's key.
      for (const item of result.results) yield* receiver.acknowledge(item.id);
      for (const item of result.repairResults.items) yield* repair.acknowledge(item.id);
      for (const item of result.deliveryResults.items) yield* distributor.acknowledge(item.id);
      cursors = {
        repairs: result.repairs.next,
        resumed: result.resumed.next,
        received: result.next,
        reportsBeforeSend: result.reportsBeforeSend.next,
        reconciliation: result.reconciliation.next,
        delivered: result.delivered.next,
        reportsAfterSend: result.reportsAfterSend.next,
        repairResults: result.repairResults.next,
        deliveryResults: result.deliveryResults.next,
      };
      if (Object.values(cursors).every((cursor) => cursor === null)) break;
    }
    return refreshRequired;
  });
});
