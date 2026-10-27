import { Effect } from 'effect'
import {
  KeyDistributor,
  KeyReceiver,
  KeyRepair,
  runWorkspaceKeyRound,
  type WorkspaceKeyRoundCursors
} from '@lody/e2ee-core'

/** Workspace-owned paging hints. Originals and retry evidence remain in core journals. */
export const makeDesktopKeyMaintenance = Effect.fnUntraced(function* () {
  const repair = yield* KeyRepair
  const receiver = yield* KeyReceiver
  const distributor = yield* KeyDistributor
  let cursors: WorkspaceKeyRoundCursors = {}
  let epoch: number | undefined
  return Effect.fnUntraced(function* (currentEpoch: number) {
    if (epoch !== currentEpoch) {
      cursors = {}
      epoch = currentEpoch
    }
    // A refresh performs finite work even if a server keeps returning hostile pages.
    for (let step = 0; step < 4; step++) {
      const result = yield* runWorkspaceKeyRound(100, cursors).pipe(
        Effect.provideService(KeyRepair, repair),
        Effect.provideService(KeyReceiver, receiver),
        Effect.provideService(KeyDistributor, distributor),
        Effect.catchTag('MailboxInstallError', (error) =>
          Effect.gen(function* () {
            // Storage, authority changes, report signing and unknown native failures
            // retry exact bytes; only core's frame-verification diagnosis permits rejection.
            if (!error.cryptographicRejection) return yield* error
            const { id } = yield* repair.enqueue(
              `rejected:${error.epoch}:${error.frameDigest}`,
              error.frameDigest
            )
            const flushed = yield* repair.flush()
            if (flushed.blocked.includes(id)) return yield* error
            // Never advance a failed page. The backend now excludes this exact digest.
            return undefined
          })
        )
      )
      if (!result) continue
      // The desktop has observed each terminal business result. ACK does not erase
      // originals, change authority or establish possession of a recipient's key.
      for (const item of result.results) yield* receiver.acknowledge(item.id)
      for (const item of result.repairResults.items) yield* repair.acknowledge(item.id)
      for (const item of result.deliveryResults.items) yield* distributor.acknowledge(item.id)
      cursors = {
        repairs: result.repairs.next,
        resumed: result.resumed.next,
        received: result.next,
        reportsBeforeSend: result.reportsBeforeSend.next,
        reconciliation: result.reconciliation.next,
        delivered: result.delivered.next,
        reportsAfterSend: result.reportsAfterSend.next,
        repairResults: result.repairResults.next,
        deliveryResults: result.deliveryResults.next
      }
      if (Object.values(cursors).every((cursor) => cursor === null)) break
    }
  })
})
