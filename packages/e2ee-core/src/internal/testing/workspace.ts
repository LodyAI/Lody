/**
 * UNSTABLE test and Lab helpers around the workspace workflows, for harnesses
 * that own their ledger client, journal and log separately.
 */
import { Context, Effect, Layer, Schema } from 'effect';
import type { GenesisHash } from '../foundation/bytes';
import type { DeviceSigner } from '../foundation/signing';
import type { LedgerCheckpoint } from '../ledger';
import type { LedgerFeedState } from '../ledger/feed-page';
import { LedgerSubmission } from '../submission';
import { WorkspaceControl } from '../workspace/control';
import { WorkspaceKeyRoundCursors, WorkspaceKeyRoundError } from '../workspace/key-round';
import { LedgerLog, LedgerSync, SubmissionJournal } from '../../services/ledger';
import { DeviceIdentity, WorkspaceScope } from '../../services/workspace';
import type { makeSqliteKeyDistribution } from './components';

/** `WorkspaceControl` over a harness-owned feed client, checkpoint source, journal and log. */
export const makeWorkspaceControlHandle = (input: {
  readonly genesis: GenesisHash;
  readonly signer: DeviceSigner;
  readonly checkpoint: () => Effect.Effect<LedgerCheckpoint, unknown>;
  readonly client: {
    current(): Effect.Effect<LedgerFeedState, unknown>;
    read(checkpoint: LedgerCheckpoint): Effect.Effect<LedgerFeedState, unknown>;
  };
  readonly journal: SubmissionJournal['Service'];
  readonly remote: LedgerLog['Service'];
}) => {
  const checkpoint = input.checkpoint,
    current = input.client.current.bind(input.client),
    read = input.client.read.bind(input.client);
  return Effect.map(
    Layer.build(
      WorkspaceControl.layer.pipe(
        Layer.provideMerge(LedgerSubmission.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              LedgerSync,
              LedgerSync.of({ current, refresh: () => Effect.flatMap(checkpoint(), read) })
            ),
            Layer.succeed(SubmissionJournal, input.journal),
            Layer.succeed(LedgerLog, input.remote),
            Layer.succeed(WorkspaceScope, { genesis: input.genesis }),
            Layer.succeed(DeviceIdentity, {
              signer: input.signer,
              encryptionKeyPair: {} as CryptoKeyPair,
            })
          )
        )
      )
    ),
    (context) => Context.get(context, WorkspaceControl)
  );
};

/** A component distribution handle (see `makeSqliteKeyDistribution`). */
export type ComponentDistribution = Effect.Success<ReturnType<typeof makeSqliteKeyDistribution>>;

/** `runWorkspaceKeyRound`'s phases over one component distribution handle. */
export const runComponentKeyRound = Effect.fnUntraced(function* <E = never, R = never>(
  distribution: ComponentDistribution,
  limit = 100,
  cursors: WorkspaceKeyRoundCursors = {},
  beforeReceive?: Effect.Effect<unknown, E, R>
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    return yield* new WorkspaceKeyRoundError({ reason: 'invalid-limit' });
  const pages = yield* Effect.fromResult(
    Schema.decodeUnknownResult(WorkspaceKeyRoundCursors)(cursors)
  ).pipe(Effect.mapError(() => new WorkspaceKeyRoundError({ reason: 'invalid-cursor' })));
  // Capture once: changing the handle's methods later cannot redirect a phase.
  const owner = Object.freeze({ ...distribution });
  if (beforeReceive) yield* beforeReceive;
  const repairs = yield* owner.flushRepairs(limit, pages.repairs ?? null);
  const resumed = yield* owner.resume(limit, pages.resumed ?? null);
  const received = yield* owner.fetchAndInstall(pages.received ?? null, limit);
  const reportsBeforeSend = yield* owner.flushReports(limit, pages.reportsBeforeSend ?? null);
  const scheduled = yield* owner.reconcileCurrentEpoch(limit, pages.reconciliation ?? null);
  const delivered = yield* owner.resumePendingDeliveries(limit, pages.delivered ?? null);
  const reportsAfterSend = yield* owner.flushReports(limit, pages.reportsAfterSend ?? null);
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
    results: yield* owner.results(limit),
    repairResults: yield* owner.repairResults(limit, pages.repairResults ?? null),
    deliveryResults: yield* owner.deliveryResults(limit, pages.deliveryResults ?? null),
  };
});
