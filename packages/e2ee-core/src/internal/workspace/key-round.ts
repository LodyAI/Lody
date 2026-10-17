import { Effect, Schema } from 'effect';
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
/**
 * One finite key-maintenance round, run on an application event (startup,
 * ledger change, reconnect): flush repairs, resume installs, fetch and install
 * one mailbox page, send reports, reconcile and send deliveries, send reports
 * again, then list unacknowledged results. Each queue keeps its own cursor
 * hint; `next` is returned only after every phase finished. No timer, no
 * background work; errors propagate.
 *
 * Requires `KeyRepair`, `KeyReceiver` and `KeyDistributor`.
 *
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
  const repair = yield* KeyRepair;
  const receiver = yield* KeyReceiver;
  const distributor = yield* KeyDistributor;
  if (beforeReceive) yield* beforeReceive;
  const repairs = yield* repair.flush(limit, pages.repairs ?? null);
  const resumed = yield* receiver.resume(limit, pages.resumed ?? null);
  const received = yield* receiver.fetchAndInstall(pages.received ?? null, limit);
  const reportsBeforeSend = yield* receiver.flushReports(limit, pages.reportsBeforeSend ?? null);
  const scheduled = yield* distributor.reconcileCurrentEpoch(limit, pages.reconciliation ?? null);
  const delivered = yield* distributor.resumePendingDeliveries(limit, pages.delivered ?? null);
  const reportsAfterSend = yield* receiver.flushReports(limit, pages.reportsAfterSend ?? null);
  return {
    scheduled: scheduled.scheduled,
    received: received.processed,
    next: received.next,
    repairs,
    resumed,
    reportsBeforeSend,
    reconciliation: scheduled,
    delivered,
    reportsAfterSend,
    results: yield* receiver.results(limit),
    repairResults: yield* repair.results(limit, pages.repairResults ?? null),
    deliveryResults: yield* distributor.results(limit, pages.deliveryResults ?? null),
  };
});
