import { Effect, Result, Schema } from 'effect';
import { KeyDistributor } from '../keys/distributor';
import { KeyReceiver } from '../keys/receiver';
import { KeyRepair } from '../keys/repair';

/** Each core queue has its own keyset; these are caller hints, never durable cursors. */
const hashCursor = Schema.optional(
  Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)))
);
const repairCursor = Schema.optional(
  Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)))
);
/** Per-queue cursor hints of a key round; each queue pages independently. Hints, never durable cursors. */
export const WorkspaceKeyRoundCursors = Schema.Struct({
  repairs: repairCursor,
  resumed: hashCursor,
  received: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)))
  ),
  reportsBeforeSend: hashCursor,
  reconciliation: hashCursor,
  delivered: hashCursor,
  reportsAfterSend: hashCursor,
  repairResults: repairCursor,
  deliveryResults: hashCursor,
});
export type WorkspaceKeyRoundCursors = typeof WorkspaceKeyRoundCursors.Type;
/** A key round's limit or cursors are invalid. @category Errors */
export class WorkspaceKeyRoundError extends Schema.TaggedError<WorkspaceKeyRoundError>()(
  'WorkspaceKeyRoundError',
  {
    reason: Schema.Literals(['invalid-limit', 'invalid-cursor']),
  }
) {}
const receiveRound = Effect.fnUntraced(function* <E = never, R = never>(
  limit: number,
  pages: WorkspaceKeyRoundCursors,
  beforeReceive?: Effect.Effect<unknown, E, R>
) {
  const repair = yield* KeyRepair;
  const receiver = yield* KeyReceiver;
  if (beforeReceive) yield* beforeReceive;
  let repairs = yield* repair.flush(limit, pages.repairs ?? null);
  const resumed = yield* receiver.resume(limit, pages.resumed ?? null);
  const received = yield* receiver.fetchAndInstall(pages.received ?? null, limit);
  for (const digest of received.retiredDigests ?? []) {
    yield* repair.enqueue(`retired:${digest}`, digest);
  }
  if (received.retiredDigests?.length) repairs = yield* repair.flush(limit, pages.repairs ?? null);
  const reportsBeforeSend = yield* receiver.flushReports(limit, pages.reportsBeforeSend ?? null);
  return {
    refreshRequired: received.refreshRequired ?? false,
    received: received.processed,
    next: received.next,
    repairs,
    resumed,
    reportsBeforeSend,
    results: yield* receiver.results(limit),
    repairResults: yield* repair.results(limit, pages.repairResults ?? null),
  };
});
const distributeRound = Effect.fnUntraced(function* (
  limit: number,
  pages: WorkspaceKeyRoundCursors
) {
  const distributor = yield* KeyDistributor;
  const scheduled = yield* distributor.reconcileCurrentEpoch(limit, pages.reconciliation ?? null);
  const delivered = yield* distributor.resumePendingDeliveries(limit, pages.delivered ?? null);
  return {
    scheduled: scheduled.scheduled,
    reconciliation: scheduled,
    delivered,
    deliveryResults: yield* distributor.results(limit, pages.deliveryResults ?? null),
  };
});
const phaseResult = <A>() =>
  Schema.declare<Result.Result<A, unknown>>((value): value is Result.Result<A, unknown> =>
    Result.isResult(value)
  );
/**
 * Both finite phases were attempted, and at least one failed. Each Result reports
 * its own outcome; successful phases retain their results and paging progress.
 * Retry with `cursors`; a failed phase's cursor is unchanged. This error never
 * grants permission to reject an envelope. Defects and interruption still propagate.
 * @category Errors
 */
export class WorkspaceKeyRoundFailure extends Schema.TaggedError<WorkspaceKeyRoundFailure>()(
  'WorkspaceKeyRoundFailure',
  {
    receive: phaseResult<Effect.Success<ReturnType<typeof receiveRound>>>(),
    distribution: phaseResult<Effect.Success<ReturnType<typeof distributeRound>>>(),
    reportsAfterSend:
      phaseResult<Effect.Success<ReturnType<KeyReceiver['Service']['flushReports']>>>(),
    cursors: WorkspaceKeyRoundCursors,
  }
) {}
/**
 * One finite key-maintenance round on startup, ledger change or reconnect.
 * Receive (including `beforeReceive`) and distribution are attempted separately:
 * a receive failure cannot gate reconciliation/delivery. Successful rounds return
 * all phase results. Partial failures report both Results and retry cursors in
 * {@link WorkspaceKeyRoundFailure}. No timer or background work is created.
 * Requires `KeyRepair`, `KeyReceiver` and `KeyDistributor`.
 * @category Workflows
 */
export const runWorkspaceKeyRound = Effect.fnUntraced(function* <E = never, R = never>(
  limit = 100,
  cursors: WorkspaceKeyRoundCursors = {},
  beforeReceive?: Effect.Effect<unknown, E, R>
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    return yield* new WorkspaceKeyRoundError({ reason: 'invalid-limit' });
  const pages = yield* Effect.fromResult(
    Schema.decodeUnknownResult(WorkspaceKeyRoundCursors)(cursors)
  ).pipe(Effect.mapError(() => new WorkspaceKeyRoundError({ reason: 'invalid-cursor' })));
  const receive = yield* Effect.result(receiveRound(limit, pages, beforeReceive));
  const distribution = yield* Effect.result(distributeRound(limit, pages));
  const receiver = yield* KeyReceiver;
  const reportsAfterSend = yield* Effect.result(
    receiver.flushReports(limit, pages.reportsAfterSend ?? null)
  );
  const nextCursors: WorkspaceKeyRoundCursors = {
    ...pages,
    ...(Result.isSuccess(receive)
      ? {
          repairs: receive.success.repairs.next,
          resumed: receive.success.resumed.next,
          received: receive.success.next,
          reportsBeforeSend: receive.success.reportsBeforeSend.next,
          repairResults: receive.success.repairResults.next,
        }
      : {}),
    ...(Result.isSuccess(distribution)
      ? {
          reconciliation: distribution.success.reconciliation.next,
          delivered: distribution.success.delivered.next,
          deliveryResults: distribution.success.deliveryResults.next,
        }
      : {}),
    ...(Result.isSuccess(reportsAfterSend)
      ? { reportsAfterSend: reportsAfterSend.success.next }
      : {}),
  };
  if (
    Result.isFailure(receive) ||
    Result.isFailure(distribution) ||
    Result.isFailure(reportsAfterSend)
  )
    return yield* new WorkspaceKeyRoundFailure({
      receive,
      distribution,
      reportsAfterSend,
      cursors: nextCursors,
    });
  return {
    ...receive.success,
    ...distribution.success,
    reportsAfterSend: reportsAfterSend.success,
  };
});
