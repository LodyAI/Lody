/** Fresh, operation-scoped recovery history batching. No history cache or authority. */
import { Effect, Exit, Request, RequestResolver } from 'effect'
import { BackendError } from '@lody/e2ee-core/services'
import type {
  E2eeWorkspaceHistoryRequest,
  E2eeWorkspaceHistoryPage,
  E2eeWorkspaceBatchReply
} from '@lody/cloud-api'

export const recoveryHistoryBatcher = Effect.fnUntraced(function* (client: {
  readonly history: (
    request: E2eeWorkspaceHistoryRequest
  ) => Effect.Effect<E2eeWorkspaceHistoryPage, BackendError>
  readonly historyBatch: (
    items: E2eeWorkspaceHistoryRequest[]
  ) => Effect.Effect<E2eeWorkspaceBatchReply<E2eeWorkspaceHistoryPage>, BackendError>
}) {
  class Read extends Request.Class<
    { readonly input: E2eeWorkspaceHistoryRequest },
    E2eeWorkspaceHistoryPage,
    BackendError
  > {}
  const resolver = RequestResolver.make<Read>(
    Effect.fnUntraced(function* (entries) {
      // The service permits only distinct workspaces in one batch. Preserve every
      // caller's own credential/checkpoint, including simultaneous reads of one id.
      const pending = [...entries]
      while (pending.length) {
        const ids = new Set<string>()
        const batch: typeof pending = []
        for (let i = 0; i < pending.length && batch.length < 64;) {
          const entry = pending[i]!
          const id = entry.request.input.workspaceId
          if (ids.has(id)) {
            i++
            continue
          }
          ids.add(id)
          batch.push(entry)
          pending.splice(i, 1)
        }
        if (batch.length === 1) {
          const entry = batch[0]!
          entry.completeUnsafe(yield* Effect.exit(client.history(entry.request.input)))
          continue
        }
        const reply = yield* Effect.exit(
          client.historyBatch(batch.map((entry) => entry.request.input))
        )
        if (Exit.isFailure(reply)) {
          for (const entry of batch) entry.completeUnsafe(Exit.failCause(reply.cause))
          continue
        }
        const items = reply.value.items
        const valid =
          items.length === batch.length &&
          items.every((item, i) => item.workspaceId === batch[i]!.request.input.workspaceId)
        batch.forEach((entry, i) => {
          const item = items[i]
          entry.completeUnsafe(
            !valid || !item
              ? Exit.fail(new BackendError({ service: 'E2eeCloud', reason: 'unavailable' }))
              : item.status === 'ok'
                ? Exit.succeed(item.result)
                : Exit.fail(
                    new BackendError({
                      service: 'E2eeCloud',
                      reason: 'unavailable',
                      cause: { code: item.code }
                    })
                  )
          )
        })
      }
    })
  ).pipe(RequestResolver.setDelay('1 millis'))
  return (input: E2eeWorkspaceHistoryRequest) =>
    Effect.request(new Read({ input: structuredClone(input) }), resolver).pipe(
      Effect.uninterruptible
    )
})
